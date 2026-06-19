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
