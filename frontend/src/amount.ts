/**
 * Human ⇆ raw amount conversion. The contract and circuits work in raw integer base units
 * (an i128, e.g. 1 XLM = 10_000_000 stroops at 7 decimals); the UI only ever shows and accepts
 * human-readable decimal amounts. Notes keep the raw value as their canonical representation.
 */

/** Parse a human decimal string (e.g. "1.5") into raw base units, given the asset's decimals. */
export function parseAmount(human: string, decimals: number): bigint {
  const s = human.trim()
  if (s === '' || s === '.' || !/^\d*\.?\d*$/.test(s)) {
    throw new Error(`invalid amount: "${human}"`)
  }
  const [intPart, fracPart = ''] = s.split('.')
  if (fracPart.length > decimals) {
    throw new Error(`too many decimal places: max ${decimals} for this asset`)
  }
  const frac = fracPart.padEnd(decimals, '0')
  return BigInt(intPart || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0')
}

/** Convert a human decimal string to a raw base-unit string (what the contract/circuits expect). */
export function toRaw(human: string, decimals: number): string {
  return parseAmount(human, decimals).toString()
}

/** Format raw base units into a human decimal string, trimming trailing fractional zeros. */
export function formatAmount(raw: string | bigint, decimals: number): string {
  const n = typeof raw === 'bigint' ? raw : BigInt(raw)
  const neg = n < 0n
  const abs = neg ? -n : n
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  const out = frac ? `${whole}.${frac}` : `${whole}`
  return neg ? `-${out}` : out
}
