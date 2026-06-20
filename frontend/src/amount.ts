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

/**
 * Compute a limit order's raw min_out from a limit price quoted as quote-per-base — the same number
 * for both sides of a pair (e.g. 63000 USD per BTC for BTC/USD). What differs is the direction of
 * the conversion: a SELL offers base for quote (multiply by price), a BUY offers quote for base
 * (divide by price). All exact integer floor math, rescaled across the base/quote decimals.
 */
export function computeMinOutAtPrice(
  amountInRaw: bigint,
  price: string,
  side: 'SELL' | 'BUY',
  decimalsBase: number,
  decimalsQuote: number,
): bigint {
  const { num, den } = parseRatio(price) // price = num/den, in quote per base
  if (side === 'SELL') {
    // amount_in is base; out is quote: amount_in × price.
    return (amountInRaw * num * 10n ** BigInt(decimalsQuote)) / (den * 10n ** BigInt(decimalsBase))
  }
  // BUY: amount_in is quote; out is base: amount_in ÷ price.
  return (amountInRaw * den * 10n ** BigInt(decimalsBase)) / (num * 10n ** BigInt(decimalsQuote))
}

/**
 * Human quote-per-base price from a raw base amount and a raw quote amount (price = quote / base),
 * rendered with up to `places` fractional digits. Returns null when base is zero. Used to show a
 * single consistent price for resting orders regardless of which way round they were placed.
 */
export function formatPrice(
  baseRaw: bigint,
  quoteRaw: bigint,
  decimalsBase: number,
  decimalsQuote: number,
  places = 6,
): string | null {
  if (baseRaw <= 0n) return null
  const scaled =
    (quoteRaw * 10n ** BigInt(decimalsBase) * 10n ** BigInt(places)) /
    (baseRaw * 10n ** BigInt(decimalsQuote))
  return formatAmount(scaled, places)
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
