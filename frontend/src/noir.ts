// In-browser execution of the small Noir "wallet math" helpers. We only EXECUTE them (no proving)
// to derive public field values — owner_tag, nullifier, order_leaf — using the exact Poseidon2
// convention as the circuits/contract. Compiled ACIR lives under /circuits/*.json.
import { Noir, type CompiledCircuit } from '@noir-lang/noir_js'

const cache = new Map<string, Promise<Noir>>()

async function load(name: string): Promise<Noir> {
  let p = cache.get(name)
  if (!p) {
    p = (async () => {
      const res = await fetch(`/circuits/${name}.json`)
      if (!res.ok) throw new Error(`failed to load circuit ${name}: ${res.status}`)
      const circuit = (await res.json()) as CompiledCircuit
      return new Noir(circuit)
    })()
    cache.set(name, p)
  }
  return p
}

function asField(v: unknown): string {
  // noir_js returns field outputs as hex strings; normalize to 0x + 64 hex chars.
  const n = BigInt(v as string)
  return '0x' + n.toString(16).padStart(64, '0')
}

/** owner_tag = compress(compress(sk,0), rho). Returns 0x + 64 hex. */
export async function noteTag(sk: string, rho: string): Promise<string> {
  const noir = await load('note_tag')
  const { returnValue } = await noir.execute({ sk, rho })
  return asField(returnValue)
}

export interface OrderTerms {
  nullifier_in: string
  output_owner_tag: string
  cancel_owner_tag: string
  order_leaf: string
}

/** Derive the public fields a lift proof binds (all 0x + 64 hex). */
export async function orderTerms(input: {
  sk: string
  rho_in: string
  rho_out: string
  rho_ord: string
  asset_in: number
  amount_in: string
  asset_out: number
  min_out: string
  expiry: number
  partial_allowed: number
}): Promise<OrderTerms> {
  const noir = await load('order_terms')
  const { returnValue } = await noir.execute({
    sk: input.sk,
    rho_in: input.rho_in,
    rho_out: input.rho_out,
    rho_ord: input.rho_ord,
    asset_in: String(input.asset_in),
    amount_in: input.amount_in,
    asset_out: String(input.asset_out),
    min_out: input.min_out,
    expiry: String(input.expiry),
    partial_allowed: String(input.partial_allowed),
  })
  const [nullifier_in, output_owner_tag, cancel_owner_tag, order_leaf] = (
    returnValue as string[]
  ).map(asField)
  return { nullifier_in, output_owner_tag, cancel_owner_tag, order_leaf }
}
