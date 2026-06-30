// Shared types for the self-contained protocol artifacts bundled with the SDK (under `assets/`):
// compiled circuit ACIR, verifying keys, the protocol-release manifest, and (when built)
// settlement.wasm / MosaicBridge.json. The concrete loaders are environment-specific — see
// `assets.node.ts` (Node `fs`) and `assets.browser.ts` (browser `fetch`), selected by the
// `@mosaic/sdk/assets` conditional export.

/** Names of the circuits whose compiled ACIR ships with the SDK. */
export type CircuitName =
  | "lift"
  | "unshield"
  | "cancel"
  | "join"
  | "note_tag"
  | "order_terms"
  | "join_terms"
  | "compress";

/** Names of the verifying keys committed for on-chain verification. */
export type VkName = "lift" | "unshield" | "cancel" | "join";

/** The protocol release manifest (wasm + VK hashes) that pins the on-chain protocol version. */
export interface ProtocolRelease {
  schema_version: number;
  wasm_hash: string;
  vk_hashes: Record<VkName, string>;
}
