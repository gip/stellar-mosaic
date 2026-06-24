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

// --- match (settle_match): 1 taker x up to 3 makers -> up to 4 proceeds + 1 remainder order ---

const M_ZERO_FIELD = '0x' + '0'.repeat(64)
const M_ZERO_PATH = Array<string>(32).fill(M_ZERO_FIELD)
const M_ZERO_BITS = Array<number>(32).fill(0)
const M_ZERO_IMT: ImtWitnessFields = {
  nullifier_root_in: '0', nullifier_root_out: '0', low_value: '0', low_next_value: '0',
  low_next_index: 0, low_path: M_ZERO_PATH, low_index_bits: M_ZERO_BITS,
  new_path: M_ZERO_PATH, new_index_bits: M_ZERO_BITS,
}

/** One order (taker or maker) the match consumes: its public terms, its order-tree membership path,
 * and its consumption-nullifier IMT-insert witness. */
export interface MatchOrderWitness {
  asset_in: number
  amount_in: string
  asset_out: number
  min_out: string
  out_tag: string
  cancel_tag: string
  expiry: number
  partial: number
  path: string[] // 32 order-tree siblings
  index_bits: number[] // 32 bits
  imt: ImtWitnessFields // its consumption-nullifier IMT insert (sequential against the running root)
}

/** A minted proceeds slot the contract emits + inserts verbatim (live=0 leaves it unminted). */
export interface MatchProceedsSlot {
  live: number
  asset: number
  amount: string
  tag: string
}

/** The taker's re-rested leftover order (live=0 => every field forced to 0). */
export interface MatchRemainder {
  live: number
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

export interface MatchInputs {
  // private witness
  taker: MatchOrderWitness
  makers: MatchOrderWitness[] // 0..3 real makers; padded to 3 with null witnesses
  // public inputs (positional; must match the contract's settle_match)
  order_root: string
  nullifier_root_in: string
  nullifier_root_out: string
  now: number
  nf_taker: string
  nf_makers: string[] // length 3 (0 for unused slots)
  proceeds: MatchProceedsSlot[] // length 4: slot 0 = taker, 1..3 = makers
  remainder: MatchRemainder
}

/** Spread one order's [..32]-sibling path + per-row IMT witness into the maker `m_*` arrays at row n.
 * Returns the per-field values to assemble into the array-of-3 inputs. */
function makerRow(w: MatchOrderWitness): {
  asset_in: string; amount_in: string; asset_out: string; min_out: string
  out_tag: string; cancel_tag: string; expiry: string; partial: string
  path: string[]; index_bits: string[]
  low_value: string; low_next_value: string; low_next_index: string
  low_path: string[]; low_index_bits: string[]; new_path: string[]; new_index_bits: string[]
} {
  return {
    asset_in: String(w.asset_in), amount_in: w.amount_in, asset_out: String(w.asset_out),
    min_out: w.min_out, out_tag: w.out_tag, cancel_tag: w.cancel_tag,
    expiry: String(w.expiry), partial: String(w.partial),
    path: w.path, index_bits: w.index_bits.map(String),
    low_value: w.imt.low_value, low_next_value: w.imt.low_next_value,
    low_next_index: String(w.imt.low_next_index),
    low_path: w.imt.low_path, low_index_bits: w.imt.low_index_bits.map(String),
    new_path: w.imt.new_path, new_index_bits: w.imt.new_index_bits.map(String),
  }
}

/** A null maker row (amount_in 0 => the circuit gates it off). */
function nullMakerRow(): ReturnType<typeof makerRow> {
  return makerRow({
    asset_in: 0, amount_in: '0', asset_out: 0, min_out: '0', out_tag: '0', cancel_tag: '0',
    expiry: 0, partial: 0, path: M_ZERO_PATH, index_bits: M_ZERO_BITS, imt: M_ZERO_IMT,
  })
}

/** Prove the WS4 match circuit in-browser (35-field PI): settle a taker against up to 3 makers,
 * minting up to 4 proceeds notes + re-resting up to 1 remainder order. The taker computes every
 * output (proceeds tags fold the per-note match nonce) and supplies them as public inputs; the
 * circuit re-derives and asserts them, so the contract mints only verified leaves. */
export async function proveMatch(input: MatchInputs): Promise<ProofBundle> {
  const compiled = await circuit('match')
  const noir = new Noir(compiled)

  const rows = [0, 1, 2].map((i) => (input.makers[i] ? makerRow(input.makers[i]) : nullMakerRow()))
  const col = <K extends keyof ReturnType<typeof makerRow>>(k: K) => rows.map((r) => r[k])
  const p = input.proceeds

  const { witness } = await noir.execute({
    // taker private
    t_asset_in: String(input.taker.asset_in), t_amount_in: input.taker.amount_in,
    t_asset_out: String(input.taker.asset_out), t_min_out: input.taker.min_out,
    t_out_tag: input.taker.out_tag, t_cancel_tag: input.taker.cancel_tag,
    t_expiry: String(input.taker.expiry), t_partial: String(input.taker.partial),
    t_path: input.taker.path, t_index_bits: input.taker.index_bits.map(String),
    t_low_value: input.taker.imt.low_value, t_low_next_value: input.taker.imt.low_next_value,
    t_low_next_index: String(input.taker.imt.low_next_index),
    t_low_path: input.taker.imt.low_path, t_low_index_bits: input.taker.imt.low_index_bits.map(String),
    t_new_path: input.taker.imt.new_path, t_new_index_bits: input.taker.imt.new_index_bits.map(String),
    // makers private (arrays of 3)
    m_asset_in: col('asset_in'), m_amount_in: col('amount_in'), m_asset_out: col('asset_out'),
    m_min_out: col('min_out'), m_out_tag: col('out_tag'), m_cancel_tag: col('cancel_tag'),
    m_expiry: col('expiry'), m_partial: col('partial'),
    m_path: col('path'), m_index_bits: col('index_bits'),
    m_low_value: col('low_value'), m_low_next_value: col('low_next_value'),
    m_low_next_index: col('low_next_index'),
    m_low_path: col('low_path'), m_low_index_bits: col('low_index_bits'),
    m_new_path: col('new_path'), m_new_index_bits: col('new_index_bits'),
    // public
    domain: '5',
    order_root: input.order_root,
    nullifier_root_in: input.nullifier_root_in,
    nullifier_root_out: input.nullifier_root_out,
    now: String(input.now),
    nf_taker: input.nf_taker,
    nf_maker0: input.nf_makers[0], nf_maker1: input.nf_makers[1], nf_maker2: input.nf_makers[2],
    p0_live: String(p[0].live), p0_asset: String(p[0].asset), p0_amount: p[0].amount, p0_tag: p[0].tag,
    p1_live: String(p[1].live), p1_asset: String(p[1].asset), p1_amount: p[1].amount, p1_tag: p[1].tag,
    p2_live: String(p[2].live), p2_asset: String(p[2].asset), p2_amount: p[2].amount, p2_tag: p[2].tag,
    p3_live: String(p[3].live), p3_asset: String(p[3].asset), p3_amount: p[3].amount, p3_tag: p[3].tag,
    remainder_live: String(input.remainder.live),
    rem_asset_in: String(input.remainder.asset_in), rem_amount_in: input.remainder.amount_in,
    rem_asset_out: String(input.remainder.asset_out), rem_min_out: input.remainder.min_out,
    rem_output_owner_tag: input.remainder.output_owner_tag,
    rem_cancel_owner_tag: input.remainder.cancel_owner_tag,
    rem_expiry: String(input.remainder.expiry),
    rem_partial_allowed: String(input.remainder.partial_allowed),
    remainder_order_leaf: input.remainder.order_leaf,
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
