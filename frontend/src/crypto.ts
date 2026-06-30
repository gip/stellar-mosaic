// Field-element helpers — now sourced from @mosaic/sdk (single source of truth; byte-identical to
// the circuits/contract, golden-tested in the SDK). Re-exported here so existing imports of
// './crypto' keep working unchanged.
export { randomField, toField32, fieldToBytes32 } from '@mosaic/sdk'
