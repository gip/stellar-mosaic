// Browser loaders for the bundled protocol artifacts. Fetches them from a configurable base URL
// (default "/", matching the frontend's `/circuits/*.json` + `/protocol-release.json` static
// layout). Exposed via the `@mosaic/sdk/assets` "browser" condition; used by `createBrowserClient`.
// During the frontend migration (Phase 5) the package `assets/` are served from the web root.

import type { CompiledCircuit } from "@noir-lang/noir_js";
import type { CircuitProvider } from "./circuits.js";
import type { CircuitName, ProtocolRelease, VkName } from "./assets.js";

export * from "./assets.js";

let baseUrl = "/";

/** Set the base URL the artifacts are served from (default "/"). */
export function configureAssets(opts: { baseUrl: string }): void {
  baseUrl = opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status}`);
  return (await res.json()) as T;
}

export async function loadCircuit(name: CircuitName | string): Promise<CompiledCircuit> {
  return fetchJson<CompiledCircuit>(`circuits/${name}.json`);
}

export async function loadVk(name: VkName): Promise<Uint8Array> {
  const res = await fetch(`${baseUrl}vks/${name}_vk`);
  if (!res.ok) throw new Error(`failed to load vk ${name}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function loadProtocolRelease(): Promise<ProtocolRelease> {
  return fetchJson<ProtocolRelease>("protocol-release.json");
}

export async function loadSettlementWasm(): Promise<Uint8Array> {
  const res = await fetch(`${baseUrl}settlement.wasm`);
  if (!res.ok) throw new Error(`failed to load settlement.wasm: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** A {@link CircuitProvider} backed by fetched ACIR — the default for `createBrowserClient`. */
export const circuitProvider: CircuitProvider = (name) => loadCircuit(name);
