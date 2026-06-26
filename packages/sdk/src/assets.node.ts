// Node loaders for the bundled protocol artifacts. Reads from the package's `assets/` directory
// (resolved relative to the compiled module, so it works regardless of cwd). Exposed to external
// consumers via the `@mosaic/sdk/assets` "node" condition; used internally by `createNodeClient`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CompiledCircuit } from "@noir-lang/noir_js";
import type { CircuitProvider } from "./circuits.js";
import type { CircuitName, ProtocolRelease, VkName } from "./assets.js";

export * from "./assets.js";

function assetPath(rel: string): string {
  // dist/assets.node.js -> ../assets/<rel>
  return fileURLToPath(new URL(`../assets/${rel}`, import.meta.url));
}

/** Load a compiled circuit's ACIR JSON (the `CompiledCircuit` shape for @noir-lang/noir_js). */
export async function loadCircuit(name: CircuitName | string): Promise<CompiledCircuit> {
  return JSON.parse(readFileSync(assetPath(`circuits/${name}.json`), "utf8")) as CompiledCircuit;
}

/** Load a verifying key's bytes. */
export async function loadVk(name: VkName): Promise<Uint8Array> {
  return new Uint8Array(readFileSync(assetPath(`vks/${name}_vk`)));
}

/** Load the protocol release manifest. */
export async function loadProtocolRelease(): Promise<ProtocolRelease> {
  return JSON.parse(readFileSync(assetPath("protocol-release.json"), "utf8")) as ProtocolRelease;
}

/** Load the settlement contract wasm bytes (built by scripts/08; throws if not bundled). */
export async function loadSettlementWasm(): Promise<Uint8Array> {
  return new Uint8Array(readFileSync(assetPath("settlement.wasm")));
}

/** A {@link CircuitProvider} backed by the bundled ACIR — the default for `createNodeClient`. */
export const circuitProvider: CircuitProvider = (name) => loadCircuit(name);
