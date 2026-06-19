// In-browser UltraHonk proving for the lift (order) circuit. Generates a proof whose bytes are
// accepted by the on-chain Nethermind verifier (validated: bb.js {keccak:true} full proof + the
// concatenated public inputs verify against the deployed VK). Secrets stay in the browser.
import { Noir, type CompiledCircuit } from '@noir-lang/noir_js'
import { UltraHonkBackend } from '@aztec/bb.js'
import { toField32 } from './crypto'

let liftCircuit: CompiledCircuit | null = null
async function lift(): Promise<CompiledCircuit> {
  if (!liftCircuit) {
    const res = await fetch('/circuits/lift.json')
    liftCircuit = (await res.json()) as CompiledCircuit
  }
  return liftCircuit
}

export interface LiftInputs {
  // private witness
  rho_in: string
  sk_o: string
  path: string[] // 32 siblings (0x hex)
  index_bits: number[] // 32 bits
  // public inputs
  root: string
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
  publicInputs: Uint8Array // 12 fields, 32B BE each (contract `public_inputs` arg)
}

/** Execute the lift witness and produce a contract-ready proof + public-inputs blob. */
export async function proveLift(input: LiftInputs): Promise<ProofBundle> {
  const circuit = await lift()
  const noir = new Noir(circuit)
  const { witness } = await noir.execute({
    rho_in: input.rho_in,
    sk_o: input.sk_o,
    path: input.path,
    index_bits: input.index_bits.map(String),
    domain: '1',
    root: input.root,
    nullifier_in: input.nullifier_in,
    asset_in: String(input.asset_in),
    amount_in: input.amount_in,
    asset_out: String(input.asset_out),
    min_out: input.min_out,
    output_owner_tag: input.output_owner_tag,
    cancel_owner_tag: input.cancel_owner_tag,
    expiry: String(input.expiry),
    partial_allowed: String(input.partial_allowed),
    order_leaf: input.order_leaf,
  })

  const backend = new UltraHonkBackend(circuit.bytecode)
  const { proof, publicInputs } = await backend.generateProof(witness, { keccak: true })

  // Concatenate the public inputs as 32-byte big-endian fields (the contract's `public_inputs`).
  const pi = new Uint8Array(publicInputs.length * 32)
  publicInputs.forEach((h, i) => {
    const hex = toField32(h).slice(2)
    for (let j = 0; j < 32; j++) pi[i * 32 + j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16)
  })

  return { proof, publicInputs: pi }
}

/** Base64-encode bytes for JSON transport to the relay. */
export function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
