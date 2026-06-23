// In-browser UltraHonk proving for the lift (order) circuit. Generates a proof whose bytes are
// accepted by the on-chain Nethermind verifier (validated: bb.js {keccak:true} full proof + the
// concatenated public inputs verify against the deployed VK). Secrets stay in the browser.
import { Noir, type CompiledCircuit } from '@noir-lang/noir_js'
import { UltraHonkBackend } from '@aztec/bb.js'
import { toField32 } from './crypto'

const circuits = new Map<string, Promise<CompiledCircuit>>()
async function circuit(name: string): Promise<CompiledCircuit> {
  let p = circuits.get(name)
  if (!p) {
    p = (async () => {
      const res = await fetch(`/circuits/${name}.json`)
      if (!res.ok) throw new Error(`failed to load circuit ${name}: ${res.status}`)
      return (await res.json()) as CompiledCircuit
    })()
    circuits.set(name, p)
  }
  return p
}

/** Pack noir_js public-input field strings as the contract's `public_inputs`: 32-byte BE each. */
function packPublicInputs(publicInputs: string[]): Uint8Array {
  const pi = new Uint8Array(publicInputs.length * 32)
  publicInputs.forEach((h, i) => {
    const hex = toField32(h).slice(2)
    for (let j = 0; j < 32; j++) pi[i * 32 + j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16)
  })
  return pi
}

/** The nullifier-IMT insert witness a WS4 spend needs (mirrors api.ImtWitnessResp). */
export interface ImtWitnessFields {
  nullifier_root_in: string
  nullifier_root_out: string
  low_value: string
  low_next_value: string
  low_next_index: number
  low_path: string[]
  low_index_bits: number[]
  new_path: string[]
  new_index_bits: number[]
}

export interface LiftInputs extends ImtWitnessFields {
  // private witness: consumed note
  rho_in: string
  sk_o: string
  nonce_in: string
  path: string[] // 32 note-tree siblings (0x hex)
  index_bits: number[] // 32 bits
  // public inputs
  note_root: string
  nullifier_in: string
  asset_in: number
  amount_in: string
  asset_out: number
  min_out: string
  output_owner_tag: string
  cancel_owner_tag: string
  expiry: number
  partial_allowed: number
  order_leaf: string
}

export interface ProofBundle {
  proof: Uint8Array // full honk proof (contract `proof` arg)
  publicInputs: Uint8Array // circuit-dependent field count, 32B BE each
}

/** Spread an IMT witness into the noir_js inputs (low_* / new_* / root transition). */
function imtFields(w: ImtWitnessFields): Record<string, unknown> {
  return {
    nullifier_root_in: w.nullifier_root_in,
    nullifier_root_out: w.nullifier_root_out,
    low_value: w.low_value,
    low_next_value: w.low_next_value,
    low_next_index: String(w.low_next_index),
    low_path: w.low_path,
    low_index_bits: w.low_index_bits.map(String),
    new_path: w.new_path,
    new_index_bits: w.new_index_bits.map(String),
  }
}

/** Execute the lift (order-placement) witness and produce a contract-ready proof + public-inputs
 * blob. WS4 14-field PI; folds the per-note nonce and proves the note-spend nullifier IMT insert. */
export async function proveLift(input: LiftInputs): Promise<ProofBundle> {
  const compiled = await circuit('lift')
  const noir = new Noir(compiled)
  const { witness } = await noir.execute({
    rho_in: input.rho_in,
    sk_o: input.sk_o,
    nonce_in: input.nonce_in,
    path: input.path,
    index_bits: input.index_bits.map(String),
    ...imtFields(input),
    domain: '1',
    note_root: input.note_root,
    nullifier_in: input.nullifier_in,
    asset_in: String(input.asset_in),
    amount_in: input.amount_in,
    asset_out: String(input.asset_out),
    min_out: input.min_out,
    output_owner_tag_pub: input.output_owner_tag,
    cancel_owner_tag: input.cancel_owner_tag,
    expiry: String(input.expiry),
    partial_allowed: String(input.partial_allowed),
    order_leaf: input.order_leaf,
  })

  const backend = new UltraHonkBackend(compiled.bytecode)
  const { proof, publicInputs } = await backend.generateProof(witness, { keccak: true })
  return { proof, publicInputs: packPublicInputs(publicInputs) }
}

export interface UnshieldInputs extends ImtWitnessFields {
  // private witness
  rho_in: string
  sk_o: string
  nonce_in: string
  path: string[] // 32 siblings (0x hex)
  index_bits: number[] // 32 bits
  // public inputs (domain is fixed to UNSHIELD_DOMAIN=2 inside)
  note_root: string
  nullifier: string
  asset: number
  amount: string
  recipient: string
}

/** Prove ownership and full consumption of one asset note, binding the public payout recipient.
 * WS4 8-field PI: domain, note_root, nf_root_in, nf_root_out, nullifier, asset, amount, recipient. */
export async function proveUnshield(input: UnshieldInputs): Promise<ProofBundle> {
  const compiled = await circuit('unshield')
  const noir = new Noir(compiled)
  const { witness } = await noir.execute({
    rho_in: input.rho_in,
    sk_o: input.sk_o,
    nonce_in: input.nonce_in,
    path: input.path,
    index_bits: input.index_bits.map(String),
    ...imtFields(input),
    domain: '2',
    note_root: input.note_root,
    nullifier: input.nullifier,
    asset: String(input.asset),
    amount: input.amount,
    recipient: input.recipient,
  })

  const backend = new UltraHonkBackend(compiled.bytecode)
  const { proof, publicInputs } = await backend.generateProof(witness, { keccak: true })
  return { proof, publicInputs: packPublicInputs(publicInputs) }
}

/** One input note's IMT-insert witness, with the low_/new_ keys suffixed for the join circuit. */
function imtFieldsSuffixed(w: ImtWitnessFields, n: 1 | 2): Record<string, unknown> {
  return {
    [`low${n}_value`]: w.low_value,
    [`low${n}_next_value`]: w.low_next_value,
    [`low${n}_next_index`]: String(w.low_next_index),
    [`low${n}_path`]: w.low_path,
    [`low${n}_index_bits`]: w.low_index_bits.map(String),
    [`new${n}_path`]: w.new_path,
    [`new${n}_index_bits`]: w.new_index_bits.map(String),
  }
}

export interface JoinInputs {
  // private witness — note 1 + its nullifier-IMT insert witness
  sk_1: string
  rho_1: string
  nonce_1: string
  amount_1: string
  path_1: string[] // 32 siblings (0x hex)
  index_bits_1: number[] // 32 bits
  imt_1: ImtWitnessFields
  // private witness — note 2 (null padding => amount_2 == 0; imt_2 gated off with zero dummies)
  sk_2: string
  rho_2: string
  nonce_2: string
  amount_2: string
  path_2: string[]
  index_bits_2: number[]
  imt_2: ImtWitnessFields
  // public inputs (domain fixed to JOIN_DOMAIN=4 inside)
  note_root: string
  nullifier_root_in: string
  nullifier_root_out: string
  nullifier_1: string
  nullifier_2: string
  asset: number
  out_tag_1: string
  out_amount_1: string
  out_tag_2: string
  out_amount_2: string
}

/** Prove the WS4 join circuit in-browser (11-field PI): consolidate two same-asset notes into two
 * fresh notes, folding each input's nonce and proving the (gated) nullifier-IMT inserts. */
export async function proveJoin(input: JoinInputs): Promise<ProofBundle> {
  const compiled = await circuit('join')
  const noir = new Noir(compiled)
  const { witness } = await noir.execute({
    sk_1: input.sk_1,
    rho_1: input.rho_1,
    nonce_1: input.nonce_1,
    amount_1: input.amount_1,
    path_1: input.path_1,
    index_bits_1: input.index_bits_1.map(String),
    ...imtFieldsSuffixed(input.imt_1, 1),
    sk_2: input.sk_2,
    rho_2: input.rho_2,
    nonce_2: input.nonce_2,
    amount_2: input.amount_2,
    path_2: input.path_2,
    index_bits_2: input.index_bits_2.map(String),
    ...imtFieldsSuffixed(input.imt_2, 2),
    domain: '4',
    note_root: input.note_root,
    nullifier_root_in: input.nullifier_root_in,
    nullifier_root_out: input.nullifier_root_out,
    nullifier_1: input.nullifier_1,
    nullifier_2: input.nullifier_2,
    asset: String(input.asset),
    out_tag_1: input.out_tag_1,
    out_amount_1: input.out_amount_1,
    out_tag_2: input.out_tag_2,
    out_amount_2: input.out_amount_2,
  })

  const backend = new UltraHonkBackend(compiled.bytecode)
  const { proof, publicInputs } = await backend.generateProof(witness, { keccak: true })
  return { proof, publicInputs: packPublicInputs(publicInputs) }
}

export interface CancelInputs extends ImtWitnessFields {
  // private witness: authority + the order's hidden terms + its order-tree path
  sk_o: string
  rho_ord: string
  asset_out: number
  min_out: string
  out_owner_tag: string
  expiry: number
  partial_allowed: number
  order_path: string[] // 32 order-tree siblings
  order_index_bits: number[]
  // public inputs (domain fixed to CANCEL_DOMAIN=3 inside)
  order_root: string
  order_nullifier: string
  asset_in: number
  amount_in: string
  return_owner_tag: string
}

/** Prove the WS4 cancel circuit in-browser: order-tree membership + cancel authority + the
 * order_leaf consumption-nullifier IMT insert. Public inputs (8 fields): domain, order_root,
 * nf_root_in, nf_root_out, order_nullifier, asset_in, amount_in, return_owner_tag. */
export async function proveCancel(input: CancelInputs): Promise<ProofBundle> {
  const compiled = await circuit('cancel')
  const noir = new Noir(compiled)
  const { witness } = await noir.execute({
    sk_o: input.sk_o,
    rho_ord: input.rho_ord,
    asset_out: String(input.asset_out),
    min_out: input.min_out,
    out_owner_tag: input.out_owner_tag,
    expiry: String(input.expiry),
    partial_allowed: String(input.partial_allowed),
    order_path: input.order_path,
    order_index_bits: input.order_index_bits.map(String),
    ...imtFields(input),
    domain: '3',
    order_root: input.order_root,
    order_nullifier: input.order_nullifier,
    asset_in: String(input.asset_in),
    amount_in: input.amount_in,
    return_owner_tag: input.return_owner_tag,
  })

  const backend = new UltraHonkBackend(compiled.bytecode)
  const { proof, publicInputs } = await backend.generateProof(witness, { keccak: true })
  return { proof, publicInputs: packPublicInputs(publicInputs) }
}

/** Base64-encode bytes for JSON transport to the relay. */
export function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
