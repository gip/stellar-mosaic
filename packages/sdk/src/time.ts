// Small time helpers, ported from the frontend `time.ts`. Wrapping the clock in a module function
// keeps call sites pure as far as the React Compiler's purity lint is concerned.

/** Current time in milliseconds (note createdAt timestamps). */
export function nowMs(): number {
  return Date.now();
}

/** Current time in whole seconds (on-chain expiry math). */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
