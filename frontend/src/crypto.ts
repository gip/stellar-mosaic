// Field-element helpers for the BN254 scalar field used by the circuits + contract.

/** Random secret field element. 31 bytes (248 bits) is always < the BN254 prime (~254 bits). */
export function randomField(): string {
  const b = new Uint8Array(31)
  crypto.getRandomValues(b)
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** Normalize a field value (hex or decimal string) to 0x + 64 lowercase hex chars. */
export function toField32(v: string | bigint): string {
  const n = typeof v === 'bigint' ? v : BigInt(v)
  return '0x' + n.toString(16).padStart(64, '0')
}

/** Field value as raw 32 bytes (big-endian) — the on-chain BytesN<32> encoding for owner tags. */
export function fieldToBytes32(v: string | bigint): Uint8Array {
  const hex = toField32(v).slice(2)
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
