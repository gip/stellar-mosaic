// Shared domain types for the Stellar Mosaic protocol. These are environment-agnostic value
// shapes used across the SDK core, adapters, CLI, and MCP. They mirror the on-chain encoding
// (field elements as `0x`+64-hex strings, amounts as i128 decimal strings) and the wallet's
// private note model (extracted from the original frontend `notes.ts`).

/** A BN254 scalar field element rendered as `0x` + 64 lowercase hex chars. */
export type Field = string;

/** An i128 amount rendered as a decimal string (raw on-chain units, not human-scaled). */
export type Amount = string;

/** Order side. SELL = give base / want quote; BUY = give quote / want base. */
export type Side = 0 | 1;
export const SIDE_BUY: Side = 0;
export const SIDE_SELL: Side = 1;

/** Immutable per-asset deposit-route class declared in the contract constructor. */
export type AssetKind = "Stellar" | "Dual" | "BaseRepresented";

export interface AssetDef {
  asset_id: number;
  symbol: string;
  /** SAC / token contract address; `null` for `BaseRepresented` (note-only) assets. */
  token: string | null;
  decimals: number;
  kind: AssetKind;
}

/** Canonical trading pair: base/quote, declared at construction (never the reverse). */
export interface PairDef {
  pair_id: number;
  base_asset: number;
  quote_asset: number;
}

export interface DeskConfig {
  id: string;
  name?: string;
  contractId: string;
  /** Admin / sponsor public key (G...). */
  sponsor?: string;
  assets: AssetDef[];
  pairs: PairDef[];
}

export type NoteRole = "asset" | "order-output" | "order-cancel";
export type NoteStatus = "active" | "spent" | "cancelled";
export type RecoveryState = "local-only" | "staged" | "protected" | "sync-error";

/** Secrets + identifiers an order maker needs to later prove cancel authority and reclaim funds.
 * Carried on the order-output (proceeds) note created when the order is placed. */
export interface OrderCancelInfo {
  rho_ord: Field;
  order_leaf: Field;
  cancel_owner_tag: Field;
  pairId: number;
  side: Side;
  asset_in: number;
  symbol_in: string;
  amount_in: Amount;
}

/** The wallet's own private record of spendable value. Secrets (`sk`, `rho`) never leave the
 * device / process. Persisted via the {@link NoteStore} port. */
export interface Note {
  id: string;
  deskId: string;
  role: NoteRole;
  asset_id: number;
  symbol: string;
  amount: Amount;
  sk: Field;
  rho: Field;
  owner_tag: Field;
  status: NoteStatus;
  /** Whether the note has appeared in the indexer / tree and can be spent. */
  indexed: boolean;
  leaf_index?: number;
  txHash?: string;
  createdAt: number;
  updatedAt?: number;
  cancel?: OrderCancelInfo;
  cancelledAt?: number;
  /** Recovery scoping. Absent on pre-recovery records (those stay local-only). */
  wallet_address?: string;
  recovery_version?: 1;
  recovery_state?: RecoveryState;
  revision?: number;
  /** Durable wallet-journal fields; a backend/MCP sees only the operation id, never the note. */
  operation_id?: string;
  operation_state?: "reserved" | "pending-output" | "committed";
}

/** A note as seen on-chain (no secrets), used to reconcile local notes by `owner_tag`. */
export interface ChainNote {
  leaf_index: number;
  asset: number;
  amount: Amount;
  owner_tag: Field;
}

/** A Merkle membership path against the live on-chain root, in the layout the `lift`/`unshield`
 * witnesses expect (LSB-first; level 0 = leaf level). */
export interface NoteProof {
  leaf_index: number;
  root: Field;
  siblings: Field[];
  index_bits: number[];
}

/** A note-tree event as read from the chain, in insertion order. Fed to the local path provider
 * (WASM NoteTree) to rebuild paths without a server. */
export type TreeEvent =
  | { kind: "shielded"; asset: number; amount: Amount; owner_tag: Field }
  | { kind: "noteins"; asset: number; amount: Amount; owner_tag: Field }
  | {
      kind: "settled";
      a_asset_out: number;
      b_amount_in: Amount;
      a_output_owner_tag: Field;
      b_asset_out: number;
      a_amount_in: Amount;
      b_output_owner_tag: Field;
    };
