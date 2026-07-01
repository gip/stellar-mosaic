// Environment ports. The SDK core defines its high-level operations once and is parameterized by
// these interfaces; the browser and Node adapters implement them differently. Switching between
// "fully local" and "MCP-connected" execution is a matter of which adapters are wired in, not a
// separate code path.

import type {
  Amount,
  AssetDef,
  AuthSession,
  BaseDeploymentConfig,
  BaseShieldConfig,
  BaseShieldJob,
  CatalogAsset,
  ChainNote,
  ClientAction,
  DeskConfig,
  Desk,
  Field,
  Fill,
  Note,
  NoteProof,
  Operation,
  OperationEvent,
  OperationRequest,
  PairDef,
  ProposeAssetBody,
  TreeEvent,
  WalletBackupEnvelope,
} from "./types.js";
import type { ActivityEvent } from "./activity.js";
export type { ActivityStore } from "./activity.js";

/** Network coordinates shared by every RPC-touching adapter. */
export interface NetworkConfig {
  /** Soroban RPC endpoint (works in browser and Node via `@stellar/stellar-sdk`). */
  rpcUrl: string;
  networkPassphrase: string;
  /** Friendbot endpoint for testnet funding (optional; Node/CLI only). */
  friendbotUrl?: string;
}

/** Result of submitting a transaction to the network. */
export interface SubmitResult {
  txHash: string;
  status: string;
}

/** A built contract invocation the {@link Submitter} will sign + send. The concrete shape is an
 * adapter detail; the core passes the contract id, method, and scval-ready args. */
export interface ContractCall {
  /** Desk id used by sponsored relays. Direct submission ignores it. */
  deskId?: string;
  contractId: string;
  method: string;
  /** Method arguments, already converted to `@stellar/stellar-sdk` `xdr.ScVal`-compatible values
   * by the core. Typed as `unknown[]` here to keep the port free of the stellar-sdk types. */
  args: unknown[];
}

// --- Signing -------------------------------------------------------------------------------------

/** Stellar / Soroban signing surface. Adapters: FreighterSigner (browser), SecretKeySigner (Node). */
export interface StellarSigner {
  /** The signer's Stellar public key (G...). */
  address(): Promise<string>;
  /** Sign a full transaction envelope (base64 XDR), returning the signed envelope XDR. */
  signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string>;
  /** Sign a single Soroban authorization entry (base64 XDR) for sponsored/relayed flows. */
  signAuthEntry(xdr: string, opts: { networkPassphrase: string }): Promise<string>;
  /** Raw ed25519 signature over an arbitrary message (used for recovery / MCP auth challenges). */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/** EVM signing surface for the Base side of the bridge. Backed by viem in both environments. */
export interface EthSigner {
  /** The signer's EVM address (0x...). */
  ethAddress(): Promise<string>;
  /** Send a transaction and return its hash. Implementations wrap a viem WalletClient. */
  sendTransaction(tx: {
    to: string;
    data?: string;
    value?: bigint;
  }): Promise<string>;
}

// --- Storage -------------------------------------------------------------------------------------

/** Persistence for private notes. Adapters: IndexedDbStorage (browser), SqliteStorage (Node,
 * default-on), MemoryStorage (tests). The pure note logic (normalize/merge/reconcile) lives in the
 * core and operates over this port. */
export interface NoteStore {
  get(id: string): Promise<Note | undefined>;
  put(note: Note): Promise<void>;
  delete(id: string): Promise<void>;
  /** All notes (any desk). */
  all(): Promise<Note[]>;
  /** All notes for a desk. */
  byDesk(deskId: string): Promise<Note[]>;
}


// --- Network sources -----------------------------------------------------------------------------

/** Read-only view of on-chain note state. The default LocalPathProvider rebuilds paths from chain
 * events using the bundled WASM NoteTree; a future BackendPathProvider could delegate to a server. */
export interface NoteSource {
  /** Current on-chain Merkle root. */
  root(deskId: string): Promise<Field>;
  /** All notes currently in the tree (no secrets), to reconcile local notes by `owner_tag`. */
  notes(deskId: string): Promise<ChainNote[]>;
  /** Membership path for the note with the given `owner_tag`, against the live root. */
  notePath(deskId: string, ownerTag: Field): Promise<NoteProof>;
  /** Raw insertion-ordered tree events, exposed for adapters that build the tree locally. */
  events(deskId: string): Promise<TreeEvent[]>;
  /** Informational order-book fill summaries from `filled` events. */
  fills?(deskId: string): Promise<Fill[]>;
}

/** Submits contract calls to the network. Default DirectSubmitter signs with the caller's own key
 * and pays its own fees (the frontend's existing `direct` mode); a SponsoredSubmitter could relay
 * through an MCP later. */
export interface Submitter {
  submit(call: ContractCall): Promise<SubmitResult>;
}

/** Funds a new account (testnet Friendbot). Node/CLI only. */
export interface Funder {
  fund(address: string): Promise<void>;
}

/** Resolves a desk's configuration (contract id, assets, pairs) by id. Adapters supply this from a
 * static registry, the chain's `assetreg`/`pairreg` events, or a backend. */
export interface DeskProvider {
  get(deskId: string): Promise<DeskConfig>;
}

/** Deploys a settlement contract (custody + book) with its immutable asset/pair/VK config. */
export interface DeploySettlementResult {
  contractId: string;
  uploadWasmTxHash?: string;
  createContractTxHash?: string;
  wasmHash?: string;
}

export interface Deployer {
  deploySettlement(params: {
    assets: AssetDef[];
    pairs: Omit<PairDef, "pair_id">[];
    admin: string;
  }): Promise<DeploySettlementResult>;
}

// --- MCP (optional server) -----------------------------------------------------------------------

/** Typed client to the authenticated MCP server for the features that require it. The first
 * release exposes authentication and the Base→Stellar shield flow; sponsorship / durable queues
 * can be added later behind this same port without changing core call sites. */
export interface McpClient {
  /** Authenticate a Stellar wallet (ed25519 challenge/response); returns an opaque session token. */
  authenticate(signer: StellarSigner): Promise<{ session: string }>;
  session(): Promise<AuthSession | null>;
  logout(): Promise<void>;
  listDesks(): Promise<Desk[]>;
  getDesk(id: string): Promise<Desk>;
  importDesk(body: {
    name: string;
    contract_id: string;
    sponsor_pubkey: string;
    event_start_ledger?: number | null;
    assets: AssetDef[];
    pairs: PairDef[];
  }): Promise<Desk>;
  createDesk(body: {
    name: string;
    assets: { catalog_id: string; asset_id: number; symbol: string; token: string; decimals: number; kind: string }[];
    pairs: { base_asset: number; quote_asset: number }[];
    base_deployment?: { deployer_address: string };
  }): Promise<Desk>;
  baseDeploymentConfig(): Promise<BaseDeploymentConfig>;
  completeBaseDeployment(id: string, body: { tx_hash: string; bridge_address: string }): Promise<Desk>;
  listAssets(): Promise<CatalogAsset[]>;
  proposeAsset(body: ProposeAssetBody): Promise<CatalogAsset>;
  trustAsset(id: string): Promise<{ ok: boolean }>;
  untrustAsset(id: string): Promise<{ ok: boolean }>;
  createOperation(body: OperationRequest, idempotencyKey?: string): Promise<Operation>;
  listOperations(): Promise<Operation[]>;
  getOperation(id: string): Promise<Operation>;
  cancelOperation(id: string): Promise<Operation>;
  claimClientAction(): Promise<{ action: ClientAction | null }>;
  heartbeatClientAction(id: string, leaseToken: string): Promise<{ lease_expires_at: number }>;
  completeClientAction(id: string, leaseToken: string, result: unknown): Promise<Operation>;
  failClientAction(id: string, leaseToken: string, error: string, retryable?: boolean): Promise<Operation>;
  operationEventsSince(cursor: number): Promise<OperationEvent[]>;
  recordActivity(events: ActivityEvent[]): Promise<ActivityEvent[]>;
  activitySince(cursor: number): Promise<ActivityEvent[]>;
  relayShield(deskId: string, txXdr: string, lease?: ClientActionLease): Promise<SubmitResult>;
  relayOrder(deskId: string, proofB64: string, publicInputsB64: string, lease?: ClientActionLease): Promise<SubmitResult>;
  relayJoin(deskId: string, proofB64: string, publicInputsB64: string, lease?: ClientActionLease): Promise<SubmitResult>;
  relayUnshield(
    deskId: string,
    to: string,
    proofB64: string,
    publicInputsB64: string,
    lease?: ClientActionLease,
  ): Promise<SubmitResult>;
  relayCancel(
    deskId: string,
    pairId: number,
    side: number,
    proofB64: string,
    publicInputsB64: string,
    lease?: ClientActionLease,
  ): Promise<SubmitResult>;
  getWalletBackup(backupId: string): Promise<WalletBackupEnvelope | null>;
  putWalletBackup(
    backupId: string,
    body: WalletBackupEnvelope & { expected_generation: number; write_token: string },
  ): Promise<{ generation: number }>;
  baseShieldConfig(deskId: string): Promise<BaseShieldConfig>;
  enqueueBaseShield(deskId: string, body: { expected_bridge: string; deposit_id: number }): Promise<BaseShieldJob>;
  listBaseShields(deskId: string): Promise<BaseShieldJob[]>;
  /** Run a Base→Stellar shield: prove the Base deposit (RISC Zero/Steel, server-side), await
   * finality, attest the block, and call `shield_from_base`. Returns the minted note's owner tag. */
  baseShield(params: {
    contractId: string;
    asset_id: number;
    amount: Amount;
    owner_tag: Field;
    baseTxHash: string;
  }): Promise<{ owner_tag: Field; txHash: string }>;
}

export interface ClientActionLease {
  action_id: string;
  lease_token: string;
}
