// The circuit-loading port. How compiled ACIR is fetched is environment-specific (browser `fetch`
// of bundled static assets vs Node `fs` read of the packaged `assets/`), but the rest of the SDK
// only needs "give me circuit <name>". The default providers come from `@mosaic/sdk/assets`.

import type { CompiledCircuit } from "@noir-lang/noir_js";

export type { CompiledCircuit };

/** Resolve a compiled circuit's ACIR by name (e.g. "lift", "unshield", "compress"). */
export type CircuitProvider = (name: string) => Promise<CompiledCircuit>;
