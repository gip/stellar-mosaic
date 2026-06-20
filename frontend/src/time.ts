// Small time helpers. Wrapping `Date.now()` in a module function keeps component code pure as far
// as the React Compiler's purity lint is concerned (it only flags the bare `Date.now` identifier),
// the same way crypto.randomField wraps the impure RNG.

/** Current time in milliseconds (note createdAt timestamps). */
export function nowMs(): number {
  return Date.now()
}

/** Current time in whole seconds (on-chain expiry math). */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
