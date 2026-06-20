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

/** Parse a positive decimal ratio (e.g. "0.12") into an exact fraction num/den. */
export function parseRatio(s: string): { num: bigint; den: bigint } {
  const t = s.trim()
  if (t === '' || t === '.' || !/^\d*\.?\d*$/.test(t)) {
    throw new Error(`invalid ratio: "${s}"`)
  }
  const [intPart, fracPart = ''] = t.split('.')
  return { num: BigInt((intPart || '0') + fracPart || '0'), den: 10n ** BigInt(fracPart.length) }
}

/**
 * Compute a limit order's raw min_out from a raw amount_in and a human "out per 1 in" ratio.
 * All exact integer math (floor): min_out = amount_in × ratio, rescaled across the two assets'
 * decimals. amount_in is raw asset_in units; the result is raw asset_out units.
 */
export function computeMinOut(
  amountInRaw: bigint,
  ratio: string,
  decimalsIn: number,
  decimalsOut: number,
): bigint {
  const { num, den } = parseRatio(ratio)
  return (amountInRaw * num * 10n ** BigInt(decimalsOut)) / (den * 10n ** BigInt(decimalsIn))
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
