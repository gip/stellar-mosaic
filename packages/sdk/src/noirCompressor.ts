// Build a {@link Compressor} backed by the `circuits/wallet/compress` Noir circuit, executed via
// ACVM. To keep the SDK core free of a hard `@noir-lang/noir_js` dependency, the executor is
// injected: the browser/Node adapters pass a real `Noir` instance (whose `execute` matches
// {@link CircuitExecutor}). Results are deterministic, so identical (a,b) pairs are memoized — this
// is what makes incremental tree rebuilds (zero ladder, unchanged subtrees) cheap.

import { toBigInt } from "./field.js";
import type { Compressor } from "./noteTree.js";

/** The slice of `@noir-lang/noir_js`'s `Noir` we rely on: execute a circuit, get its return value.
 * `returnValue` is a field hex string for the single-output `compress` circuit. */
export interface CircuitExecutor {
  execute(inputs: Record<string, string>): Promise<{ returnValue: unknown }>;
}

/** Wrap a compiled-`compress` executor as a memoizing {@link Compressor}. */
export function makeNoirCompressor(executor: CircuitExecutor): Compressor {
  const cache = new Map<string, Promise<bigint>>();
  return (a: bigint, b: bigint): Promise<bigint> => {
    const key = `${a}:${b}`;
    let p = cache.get(key);
    if (!p) {
      p = (async () => {
        const { returnValue } = await executor.execute({ a: a.toString(), b: b.toString() });
        return toBigInt(returnValue as string);
      })();
      cache.set(key, p);
    }
    return p;
  };
}
