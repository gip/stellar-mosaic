import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ActivityEvent,
  AuthSession,
  BaseShieldJob,
  BaseShieldDeposit,
  CatalogAsset,
  ClientAction,
  Desk,
  Operation,
  OperationEvent,
  OperationRequest,
  WalletBackupEnvelope,
  MosaicMcpErrorBody,
} from "@mosaic/sdk";
import { normalizeActivityEvent } from "@mosaic/sdk";
import { envNumber } from "./env.js";
import { MosaicMcpError, classifyMcpError } from "./errors.js";

const now = () => Date.now();
const SESSION_TTL_MS = 60 * 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const LEASE_TTL_MS = 90_000;

/** How long a claimed base-shield job stays locked to its worker. This must outlive the longest a
 * single worker can hold a job within one tick — otherwise a second process re-claims a job that is
 * still being minted and double-drives it. A tick advances one job per stage sequentially: the mint
 * stage runs two `stellar` CLI calls (each hard-capped at the CLI timeout) and the network stages a
 * handful of `fetch`es (each hard-capped at the fetch timeout), so the lease is derived from those
 * same caps plus margin. (The contract's deposit-id idempotency is the last-resort backstop against
 * an actual double mint; this lease prevents the wasted work and status clobbering.) */
function baseShieldLeaseTtlMs(): number {
  const cliCap = envNumber("MOSAIC_MCP_CLI_TIMEOUT_MS", 120_000);
  const fetchCap = envNumber("MOSAIC_MCP_FETCH_TIMEOUT_MS", 30_000);
  return 2 * cliCap + 3 * fetchCap + 60_000;
}

export interface StoredChallenge {
  id: string;
  address: string;
  network: string;
  audience: string;
  message: string;
  issued_at: number;
  expires_at: number;
}

interface StoredBackup extends WalletBackupEnvelope {
  write_token_hash: string;
  read_token_hash?: string | null;
  owner_address?: string | null;
}

export interface MosaicStore {
  createChallenge(address: string, message: string, network?: string, audience?: string): Promise<StoredChallenge>;
  consumeChallenge(id: string, address: string): Promise<StoredChallenge>;
  createSession(address: string, network: string): Promise<{ token: string; session: AuthSession }>;
  getSession(token: string): Promise<AuthSession | null>;
  deleteSession(token: string): Promise<void>;
  listDesks(): Promise<Desk[]>;
  getDesk(id: string): Promise<Desk>;
  insertDesk(desk: Desk, sponsorSecret?: string | null): Promise<Desk>;
  sponsorSecret(deskId: string): Promise<string | null>;
  listAssets(address?: string): Promise<CatalogAsset[]>;
  proposeAsset(body: Partial<CatalogAsset>, proposer: string): Promise<CatalogAsset>;
  setTrust(assetId: string, address: string, trusted: boolean): Promise<{ ok: boolean }>;
  createOperation(address: string, network: string, request: OperationRequest, idempotencyKey: string): Promise<Operation>;
  listOperations(address: string): Promise<Operation[]>;
  getOperation(address: string, id: string): Promise<Operation>;
  cancelOperation(address: string, id: string): Promise<Operation>;
  claimAction(address: string): Promise<ClientAction | null>;
  heartbeatAction(address: string, id: string, leaseToken: string): Promise<{ lease_expires_at: number }>;
  validateActionLease(address: string, id: string, leaseToken: string): Promise<{ operation: Operation; action: ClientAction }>;
  completeAction(address: string, id: string, leaseToken: string, result: unknown): Promise<Operation>;
  failAction(address: string, id: string, leaseToken: string, error: string, retryable: boolean): Promise<Operation>;
  eventsAfter(address: string, cursor: number): Promise<OperationEvent[]>;
  recordActivity(address: string, network: string, events: ActivityEvent[]): Promise<ActivityEvent[]>;
  activityAfter(address: string, network: string, cursor: number): Promise<ActivityEvent[]>;
  getWalletBackup(backupId: string): Promise<WalletBackupEnvelope | null>;
  putWalletBackup(
    backupId: string,
    writeToken: string,
    readToken: string | undefined,
    expectedGeneration: number,
    envelope: WalletBackupEnvelope,
    ownerAddress?: string,
  ): Promise<{ generation: number }>;
  getWalletBackupForRead(backupId: string, readToken?: string, address?: string): Promise<WalletBackupEnvelope | null>;
  enqueueBaseShield(deskId: string, bridge: string, depositId: number, ownerAddress: string, deposit?: BaseShieldDeposit): Promise<BaseShieldJob>;
  listBaseShields(deskId: string, ownerAddress?: string): Promise<BaseShieldJob[]>;
  retryBaseShield(id: string, ownerAddress?: string): Promise<BaseShieldJob>;
  /** Oldest active base-shield job per lifecycle stage (proving|awaiting_finality|minting), in that
   * stage order — one deposit's finality wait must not block the next deposit's proving. */
  nextBaseShields(): Promise<BaseShieldJob[]>;
  /** Persist the proof + committed block and advance the job. When `requireFinality` is true the job
   * moves to `awaiting_finality` (the worker then waits for Base L1 finality); otherwise it goes
   * straight to `minting`. */
  baseShieldProved(
    id: string,
    blockNumber: number,
    blockHash: string,
    sealHex: string,
    journalHex: string,
    requireFinality: boolean,
  ): Promise<void>;
  /** Move a job to a new status (e.g. `minting`, `active`). */
  baseShieldStatus(id: string, status: string, stellarTxHash?: string): Promise<void>;
  /** Release a worker lock when a job step made no state change (e.g. remote proof still running). */
  baseShieldRelease(id: string): Promise<void>;
  /** Record a transient step failure: bump `attempts` and keep the job in its current stage so the
   * worker retries it on a later tick. */
  baseShieldRetry(id: string, error: string, failure?: MosaicMcpErrorBody): Promise<void>;
  /** Move a job to the terminal `failed` state with a message. */
  baseShieldFailed(id: string, error: string, failure?: MosaicMcpErrorBody): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; path?: string }>;
}

/** Base-shield job states that the worker still needs to advance, in pipeline order. */
const BASE_SHIELD_STAGES = ["proving", "awaiting_finality", "minting"] as const;

/** Oldest job per active stage, from jobs given in insertion order — the worker's per-tick batch. */
function oldestBaseShieldPerStage(jobs: Iterable<BaseShieldJob>): BaseShieldJob[] {
  const byStage = new Map<string, BaseShieldJob>();
  for (const job of jobs) {
    if (!byStage.has(job.status)) byStage.set(job.status, job);
  }
  return BASE_SHIELD_STAGES.map((stage) => byStage.get(stage)).filter((job): job is BaseShieldJob => job !== undefined);
}

/** Clear the retry state — every stage transition starts with a fresh attempt budget. */
function resetRetryState(job: BaseShieldJob): void {
  job.attempts = 0;
  job.error = null;
  job.failure = null;
  job.locked_by = null;
  job.lock_expires_at = null;
}

/** The stage a failed job resumes at when retried. A job that already has its proof artifacts must
 * re-enter the finality wait when the deposit requires finality — jumping straight to `minting` would
 * attest+mint a Base block that was never confirmed finalized (a reorg could then orphan the deposit
 * after the Stellar note is minted). Only a job that never got past proving restarts from `proving`. */
function resumeStatusForRetry(job: BaseShieldJob): string {
  if (!job.seal_hex || !job.journal_hex) return "proving";
  return job.require_finality ? "awaiting_finality" : "minting";
}

/** Record one more transient step failure in the job's current stage. */
function bumpRetryState(job: BaseShieldJob, error: string): void {
  job.attempts = (job.attempts ?? 0) + 1;
  job.error = error;
}

/**
 * Reject a base-shield enqueue whose bridge disagrees with what the desk was actually configured
 * with on-chain (recorded at deploy). This is the drift guard: a stale front-end must not queue a
 * job that would prove against the wrong bridge.
 */
async function assertBridgeMatches(store: MosaicStore, deskId: string, bridge: string): Promise<void> {
  const desk = await store.getDesk(deskId);
  const configured = desk.base_deployment?.bridge_address ?? null;
  if (!configured) throw new Error(`desk ${deskId} has no configured Base bridge`);
  if (configured.toLowerCase() !== bridge.toLowerCase()) {
    throw new Error(`bridge mismatch: desk ${deskId} is configured for ${configured}, not ${bridge}`);
  }
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Authorize a wallet-backup read against the single policy both stores share. A backup is readable
 * only by presenting its read token (if one was set) or by an authenticated session whose address
 * owns it. Anything else — a mismatched/absent token, a mismatched/absent owner, or a backup that
 * carries neither credential — is denied. Throws on failure; returns normally when authorized.
 *
 * Callers must not fall back to "any authenticated session" or "any non-empty token": a backup with
 * neither a read-token hash nor an owner has no reader and must be refused rather than leaked. */
function authorizeBackupRead(backup: StoredBackup, readToken?: string, address?: string): void {
  if (backup.read_token_hash) {
    if (!readToken || backup.read_token_hash !== tokenHash(readToken)) {
      throw new MosaicMcpError("AUTH_INVALID", "backup read token mismatch");
    }
    return;
  }
  if (backup.owner_address) {
    if (!address || backup.owner_address !== address) throw new MosaicMcpError("AUTH_INVALID", "backup owner mismatch");
    return;
  }
  throw new MosaicMcpError("AUTH_INVALID", "backup read token or authenticated owner required");
}

function secretKey(): Buffer | null {
  const key = process.env.MOSAIC_SERVER_KEY;
  return key ? createHash("sha256").update(key).digest() : null;
}

function protectSecret(value: string): string {
  const key = secretKey();
  if (!key && process.env.NODE_ENV === "production") {
    throw new MosaicMcpError("VALIDATION_FAILED", "MOSAIC_SERVER_KEY is required to persist sponsor custody in production");
  }
  if (!key) return value;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${Buffer.concat([nonce, tag, ciphertext]).toString("base64url")}`;
}

function revealSecret(value: string): string {
  if (!value.startsWith("enc:v1:")) return value;
  const key = secretKey();
  if (!key) throw new Error("MOSAIC_SERVER_KEY is required to decrypt sponsor custody");
  const raw = Buffer.from(value.slice("enc:v1:".length), "base64url");
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function actionClaimable(action: { status: string; lease_expires_at: number }, operation?: { status: string }): boolean {
  if (operation?.status !== "waiting_for_client") return false;
  return action.status === "available" || (action.status === "leased" && action.lease_expires_at < now());
}

function defaultCatalog(nowMs: number): CatalogAsset[] {
  return [
    {
      id: "default-usdc",
      symbol: "USDC",
      stellar_token: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      stellar_decimals: 7,
      base_chain_id: 84532,
      base_token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      base_decimals: 6,
      proposer_address: null,
      is_default: true,
      created_at: nowMs,
      trust_count: 0,
      trusted_by_me: true,
    },
    {
      id: "default-xlm",
      symbol: "XLM",
      stellar_token: "native",
      stellar_decimals: 7,
      base_chain_id: null,
      base_token: null,
      base_decimals: null,
      proposer_address: null,
      is_default: true,
      created_at: nowMs,
      trust_count: 0,
      trusted_by_me: true,
    },
    {
      id: "default-eth",
      symbol: "ETH",
      stellar_token: "represented",
      stellar_decimals: 18,
      base_chain_id: 84532,
      base_token: "native",
      base_decimals: 18,
      proposer_address: null,
      is_default: true,
      created_at: nowMs,
      trust_count: 0,
      trusted_by_me: true,
    },
  ];
}

export class MemoryMosaicStore implements MosaicStore {
  private readonly challenges = new Map<string, StoredChallenge>();
  private readonly sessions = new Map<string, AuthSession & { token_hash: string }>();
  private readonly desks = new Map<string, Desk>();
  private readonly sponsors = new Map<string, string>();
  private readonly assets = new Map<string, CatalogAsset>();
  private readonly trusts = new Map<string, Set<string>>();
  private readonly operations = new Map<string, Operation>();
  private readonly operationKeys = new Map<string, string>();
  private readonly actions = new Map<string, ClientAction & { address: string; status: string; result?: unknown }>();
  private readonly events: OperationEvent[] = [];
  private readonly activityEvents: ActivityEvent[] = [];
  private readonly activityById = new Map<string, ActivityEvent>();
  private readonly activityByIdempotency = new Map<string, ActivityEvent>();
  private readonly backups = new Map<string, StoredBackup>();
  private readonly baseShields = new Map<string, BaseShieldJob>();
  private cursor = 0;
  private activityCursor = 0;

  constructor() {
    for (const asset of defaultCatalog(now())) this.assets.set(asset.id, asset);
  }

  async createChallenge(address: string, message: string, network = "testnet", audience = "mosaic-mcp"): Promise<StoredChallenge> {
    const issued_at = now();
    const challenge = { id: randomUUID(), address, network, audience, message, issued_at, expires_at: issued_at + CHALLENGE_TTL_MS };
    this.challenges.set(challenge.id, challenge);
    return clone(challenge);
  }

  async consumeChallenge(id: string, address: string): Promise<StoredChallenge> {
    const challenge = this.challenges.get(id);
    if (!challenge || challenge.address !== address || challenge.expires_at < now()) {
      throw new Error("unknown or expired challenge");
    }
    this.challenges.delete(id);
    return clone(challenge);
  }

  async createSession(address: string, network: string): Promise<{ token: string; session: AuthSession }> {
    const token = randomBytes(32).toString("hex");
    const session = { address, network, expires_at: now() + SESSION_TTL_MS };
    this.sessions.set(tokenHash(token), { ...session, token_hash: tokenHash(token) });
    return { token, session: clone(session) };
  }

  async getSession(token: string): Promise<AuthSession | null> {
    const session = this.sessions.get(tokenHash(token));
    if (!session || (session.expires_at !== undefined && session.expires_at < now())) return null;
    return { address: session.address, network: session.network, expires_at: session.expires_at };
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(tokenHash(token));
  }

  async listDesks(): Promise<Desk[]> {
    return [...this.desks.values()].map(clone);
  }

  async getDesk(id: string): Promise<Desk> {
    const desk = this.desks.get(id);
    if (!desk) throw new Error(`desk ${id} not found`);
    return clone(desk);
  }

  async insertDesk(desk: Desk, sponsorSecret?: string | null): Promise<Desk> {
    this.desks.set(desk.id, clone(desk));
    if (sponsorSecret) this.sponsors.set(desk.id, protectSecret(sponsorSecret));
    return clone(desk);
  }

  async sponsorSecret(deskId: string): Promise<string | null> {
    const secret = this.sponsors.get(deskId);
    return secret ? revealSecret(secret) : null;
  }

  async listAssets(address?: string): Promise<CatalogAsset[]> {
    return [...this.assets.values()].map((asset) => {
      const trusted = this.trusts.get(asset.id);
      return {
        ...clone(asset),
        trust_count: trusted?.size ?? 0,
        trusted_by_me: asset.is_default || (!!address && !!trusted?.has(address)),
      };
    });
  }

  async proposeAsset(body: Partial<CatalogAsset>, proposer: string): Promise<CatalogAsset> {
    const asset: CatalogAsset = {
      id: randomUUID(),
      symbol: String(body.symbol ?? "").trim().toUpperCase(),
      stellar_token: body.stellar_token ?? null,
      stellar_decimals: body.stellar_decimals ?? null,
      base_chain_id: body.base_chain_id ?? null,
      base_token: body.base_token ?? null,
      base_decimals: body.base_decimals ?? null,
      proposer_address: proposer,
      is_default: false,
      created_at: now(),
      trust_count: 0,
      trusted_by_me: true,
    };
    if (!asset.symbol) throw new Error("symbol required");
    this.assets.set(asset.id, asset);
    await this.setTrust(asset.id, proposer, true);
    return clone((await this.listAssets(proposer)).find((item) => item.id === asset.id)!);
  }

  async setTrust(assetId: string, address: string, trusted: boolean): Promise<{ ok: boolean }> {
    if (!this.assets.has(assetId)) throw new Error(`asset ${assetId} not found`);
    const set = this.trusts.get(assetId) ?? new Set<string>();
    this.trusts.set(assetId, set);
    if (trusted) set.add(address);
    else set.delete(address);
    return { ok: true };
  }

  async createOperation(address: string, network: string, request: OperationRequest, idempotencyKey: string): Promise<Operation> {
    const key = `${address}\0${network}\0${idempotencyKey}`;
    const existing = this.operationKeys.get(key);
    if (existing) return this.getOperation(address, existing);
    const operation: Operation = {
      id: randomUUID(),
      address,
      network,
      desk_id: request.desk_id,
      kind: request.kind,
      request,
      status: "waiting_for_client",
      created_at: now(),
      updated_at: now(),
      error: null,
      submitted: false,
    };
    const action: ClientAction & { address: string; status: string } = {
      id: randomUUID(),
      operation_id: operation.id,
      kind: operation.kind,
      payload: request,
      lease_token: "",
      lease_expires_at: 0,
      address,
      status: "available",
    };
    this.operations.set(operation.id, operation);
    this.operationKeys.set(key, operation.id);
    this.actions.set(action.id, action);
    this.addEvent(operation, "created", "waiting_for_client", "Operation queued for wallet action.", {});
    return clone(operation);
  }

  async listOperations(address: string): Promise<Operation[]> {
    return [...this.operations.values()]
      .filter((operation) => operation.address === address)
      .sort((a, b) => b.created_at - a.created_at)
      .map(clone);
  }

  async getOperation(address: string, id: string): Promise<Operation> {
    const operation = this.operations.get(id);
    if (!operation || operation.address !== address) throw new Error(`operation ${id} not found`);
    return clone(operation);
  }

  async cancelOperation(address: string, id: string): Promise<Operation> {
    const operation = await this.getOperation(address, id);
    if (operation.status !== "succeeded" && operation.status !== "failed") {
      operation.status = "cancelled";
      operation.updated_at = now();
      this.operations.set(operation.id, operation);
      this.addEvent(operation, "cancelled", "cancelled", "Operation cancelled.", {});
    }
    return clone(operation);
  }

  async claimAction(address: string): Promise<ClientAction | null> {
    const action = [...this.actions.values()]
      .filter((item) => item.address === address && actionClaimable(item, this.operations.get(item.operation_id)))
      .sort((a, b) => (this.operations.get(a.operation_id)?.created_at ?? 0) - (this.operations.get(b.operation_id)?.created_at ?? 0))[0];
    if (!action) return null;
    action.status = "leased";
    action.lease_token = randomBytes(32).toString("hex");
    action.lease_expires_at = now() + LEASE_TTL_MS;
    this.actions.set(action.id, action);
    return clone(action);
  }

  async heartbeatAction(address: string, id: string, leaseToken: string): Promise<{ lease_expires_at: number }> {
    const { action } = await this.validateActionLease(address, id, leaseToken);
    action.lease_expires_at = now() + LEASE_TTL_MS;
    this.actions.set(action.id, { ...action, address, status: "leased" });
    return { lease_expires_at: action.lease_expires_at };
  }

  async validateActionLease(address: string, id: string, leaseToken: string): Promise<{ operation: Operation; action: ClientAction }> {
    const action = this.actions.get(id);
    if (!action || action.address !== address || action.lease_token !== leaseToken || action.lease_expires_at < now()) {
      throw new Error("invalid or expired client action lease");
    }
    return { operation: await this.getOperation(address, action.operation_id), action: clone(action) };
  }

  async completeAction(address: string, id: string, leaseToken: string, result: unknown): Promise<Operation> {
    const { operation, action } = await this.validateActionLease(address, id, leaseToken);
    operation.status = "succeeded";
    operation.updated_at = now();
    operation.submitted = true;
    this.operations.set(operation.id, operation);
    this.actions.set(action.id, { ...action, address, status: "complete", result });
    this.addEvent(operation, "succeeded", "succeeded", "Operation succeeded.", result);
    return clone(operation);
  }

  async failAction(address: string, id: string, leaseToken: string, error: string, retryable: boolean): Promise<Operation> {
    const { operation, action } = await this.validateActionLease(address, id, leaseToken);
    operation.status = retryable ? "waiting_for_client" : "failed";
    operation.error = error;
    operation.updated_at = now();
    this.operations.set(operation.id, operation);
    this.actions.set(action.id, { ...action, address, status: retryable ? "available" : "failed" });
    this.addEvent(operation, "failed", operation.status, error, { retryable });
    return clone(operation);
  }

  async eventsAfter(address: string, cursor: number): Promise<OperationEvent[]> {
    return this.events.filter((event) => event.cursor > cursor && this.operations.get(event.operation_id)?.address === address).map(clone);
  }

  async recordActivity(address: string, network: string, events: ActivityEvent[]): Promise<ActivityEvent[]> {
    const out: ActivityEvent[] = [];
    for (const event of events) out.push(this.recordOneActivity(address, network, event));
    return out.map(clone);
  }

  async activityAfter(address: string, network: string, cursor: number): Promise<ActivityEvent[]> {
    return this.activityEvents
      .filter((event) => event.wallet_address === address && event.network === network && (event.cursor ?? 0) > cursor)
      .sort((a, b) => (a.cursor ?? 0) - (b.cursor ?? 0))
      .map(clone);
  }

  async getWalletBackup(backupId: string): Promise<WalletBackupEnvelope | null> {
    const backup = this.backups.get(backupId);
    if (!backup) return null;
    const { write_token_hash: _writeTokenHash, ...envelope } = backup;
    return clone(envelope);
  }

  async putWalletBackup(
    backupId: string,
    writeToken: string,
    readToken: string | undefined,
    expectedGeneration: number,
    envelope: WalletBackupEnvelope,
    ownerAddress?: string,
  ): Promise<{ generation: number }> {
    const existing = this.backups.get(backupId);
    if (existing && existing.generation !== expectedGeneration) throw new MosaicMcpError("CONFLICT", "backup generation conflict");
    if (existing && existing.write_token_hash !== tokenHash(writeToken)) throw new MosaicMcpError("AUTH_INVALID", "backup write token mismatch");
    const generation = expectedGeneration + 1;
    // A tokenless update must not silently drop an existing read credential (that would turn a
    // protected backup world-readable): fall back to the stored hash / owner when not re-supplied.
    this.backups.set(backupId, {
      ...envelope,
      generation,
      write_token_hash: tokenHash(writeToken),
      read_token_hash: readToken ? tokenHash(readToken) : existing?.read_token_hash ?? null,
      owner_address: ownerAddress ?? existing?.owner_address ?? null,
    });
    return { generation };
  }

  async getWalletBackupForRead(backupId: string, readToken?: string, address?: string): Promise<WalletBackupEnvelope | null> {
    const backup = this.backups.get(backupId);
    if (!backup) return null;
    authorizeBackupRead(backup, readToken, address);
    const { write_token_hash: _writeTokenHash, read_token_hash: _readTokenHash, owner_address: _ownerAddress, ...envelope } = backup;
    return clone(envelope);
  }

  async enqueueBaseShield(deskId: string, bridge: string, depositId: number, ownerAddress: string, deposit?: BaseShieldDeposit): Promise<BaseShieldJob> {
    await assertBridgeMatches(this, deskId, bridge);
    const key = `${deskId}\0${bridge}\0${depositId}`;
    const existing = this.baseShields.get(key);
    if (existing) return clone(existing);
    const job: BaseShieldJob = {
      id: randomUUID(),
      desk_id: deskId,
      owner_address: ownerAddress,
      bridge,
      deposit_id: depositId,
      status: "proving",
      version: 0,
      locked_by: null,
      lock_expires_at: null,
      block_number: null,
      block_hash: null,
      deposit,
      error: null,
      failure: null,
    };
    this.baseShields.set(key, job);
    return clone(job);
  }

  async listBaseShields(deskId: string, ownerAddress?: string): Promise<BaseShieldJob[]> {
    return [...this.baseShields.values()]
      .filter((job) => job.desk_id === deskId && (!ownerAddress || !job.owner_address || job.owner_address === ownerAddress))
      .map(clone);
  }

  async retryBaseShield(id: string, ownerAddress?: string): Promise<BaseShieldJob> {
    const job = this.baseShieldById(id);
    if (!job) throw new MosaicMcpError("NOT_FOUND", `base-shield job ${id} not found`);
    if (ownerAddress && job.owner_address && job.owner_address !== ownerAddress) throw new MosaicMcpError("AUTH_INVALID", "base-shield job owner mismatch");
    if (job.status !== "failed") return clone(job);
    job.status = resumeStatusForRetry(job);
    job.version = (job.version ?? 0) + 1;
    resetRetryState(job);
    return clone(job);
  }

  private baseShieldById(id: string): BaseShieldJob | undefined {
    for (const job of this.baseShields.values()) if (job.id === id) return job;
    return undefined;
  }

  async nextBaseShields(): Promise<BaseShieldJob[]> {
    // Map iteration preserves insertion order, so "first per stage" is "oldest per stage".
    const worker = randomUUID();
    const lockUntil = now() + baseShieldLeaseTtlMs();
    const jobs = oldestBaseShieldPerStage([...this.baseShields.values()].filter((job) => !job.lock_expires_at || job.lock_expires_at < now()));
    for (const job of jobs) {
      job.locked_by = worker;
      job.lock_expires_at = lockUntil;
      job.version = (job.version ?? 0) + 1;
    }
    return jobs.map(clone);
  }

  async baseShieldProved(
    id: string,
    blockNumber: number,
    blockHash: string,
    sealHex: string,
    journalHex: string,
    requireFinality: boolean,
  ): Promise<void> {
    const job = this.baseShieldById(id);
    if (!job) throw new Error(`base-shield job ${id} not found`);
    job.status = requireFinality ? "awaiting_finality" : "minting";
    job.require_finality = requireFinality;
    job.block_number = blockNumber;
    job.block_hash = blockHash;
    job.seal_hex = sealHex;
    job.journal_hex = journalHex;
    resetRetryState(job);
    job.version = (job.version ?? 0) + 1;
  }

  async baseShieldStatus(id: string, status: string, stellarTxHash?: string): Promise<void> {
    const job = this.baseShieldById(id);
    if (!job) throw new Error(`base-shield job ${id} not found`);
    job.status = status;
    if (stellarTxHash) job.stellar_tx_hash = stellarTxHash;
    resetRetryState(job);
    job.version = (job.version ?? 0) + 1;
  }

  async baseShieldRelease(id: string): Promise<void> {
    const job = this.baseShieldById(id);
    if (!job) throw new Error(`base-shield job ${id} not found`);
    job.locked_by = null;
    job.lock_expires_at = null;
    job.version = (job.version ?? 0) + 1;
  }

  async baseShieldRetry(id: string, error: string, failure?: MosaicMcpErrorBody): Promise<void> {
    const job = this.baseShieldById(id);
    if (!job) throw new Error(`base-shield job ${id} not found`);
    bumpRetryState(job, error);
    job.failure = failure ?? classifyMcpError(error).body();
    job.locked_by = null;
    job.lock_expires_at = null;
    job.version = (job.version ?? 0) + 1;
  }

  async baseShieldFailed(id: string, error: string, failure?: MosaicMcpErrorBody): Promise<void> {
    const job = this.baseShieldById(id);
    if (!job) throw new Error(`base-shield job ${id} not found`);
    job.status = "failed";
    job.error = error;
    job.failure = failure ?? classifyMcpError(error).body();
    job.locked_by = null;
    job.lock_expires_at = null;
    job.version = (job.version ?? 0) + 1;
  }

  async healthCheck(): Promise<{ ok: boolean; path?: string }> {
    return { ok: true, path: "memory" };
  }

  private addEvent(operation: Operation, event_type: string, state: string, message: string, details: unknown): void {
    this.events.push({
      cursor: ++this.cursor,
      operation_id: operation.id,
      event_type,
      state,
      message,
      details,
      created_at: now(),
    });
  }

  private recordOneActivity(address: string, network: string, event: ActivityEvent): ActivityEvent {
    const stored = normalizeActivityEvent({ ...event, wallet_address: address, network });
    if (!stored.id) throw new Error("activity event id required");
    const idempotencyKey = stored.idempotency_key ? `${address}\0${network}\0${stored.idempotency_key}` : undefined;
    if (idempotencyKey) {
      const existing = this.activityByIdempotency.get(idempotencyKey);
      if (existing) return clone(existing);
    }
    const idKey = `${address}\0${network}\0${stored.id}`;
    const existing = this.activityById.get(idKey);
    if (existing) return clone(existing);
    const withCursor = { ...stored, cursor: ++this.activityCursor };
    this.activityEvents.push(withCursor);
    this.activityById.set(idKey, withCursor);
    if (idempotencyKey) this.activityByIdempotency.set(idempotencyKey, withCursor);
    return clone(withCursor);
  }
}

type StoredAction = ClientAction & { address: string; status: string; result?: unknown };
type StoredSession = AuthSession & { token_hash: string };

function parseJson<T>(row: { json: string } | undefined): T | undefined {
  return row ? (JSON.parse(row.json) as T) : undefined;
}

function sqlitePath(databaseUrl: string): string {
  if (databaseUrl === ":memory:" || databaseUrl === "sqlite::memory:" || databaseUrl === "sqlite://:memory:") {
    return ":memory:";
  }
  if (databaseUrl.startsWith("sqlite://")) return databaseUrl.slice("sqlite://".length);
  if (databaseUrl.startsWith("sqlite:")) return databaseUrl.slice("sqlite:".length);
  if (/^(postgres|postgresql):\/\//.test(databaseUrl)) {
    throw new Error("MCP persistence now uses sqlite3; set MOSAIC_DATABASE_URL=sqlite://./mosaic-mcp.db");
  }
  return databaseUrl;
}

function requireProductionSafePath(path: string): void {
  if (process.env.NODE_ENV !== "production" || path === ":memory:") return;
  if (!path.startsWith("/")) {
    throw new MosaicMcpError("VALIDATION_FAILED", "MOSAIC_DATABASE_URL must be an absolute sqlite path in production");
  }
}

export class SqliteMosaicStore implements MosaicStore {
  private readonly db: DatabaseSync;
  private readonly path: string;

  constructor(databaseUrl = "sqlite://./mosaic-mcp.db") {
    const path = sqlitePath(databaseUrl);
    requireProductionSafePath(path);
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA user_version = 1;
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, address TEXT NOT NULL, network TEXT NOT NULL DEFAULT 'testnet', audience TEXT NOT NULL DEFAULT 'mosaic-mcp', message TEXT NOT NULL, issued_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, json TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS desks (id TEXT PRIMARY KEY, json TEXT NOT NULL, sponsor_secret TEXT);
      CREATE TABLE IF NOT EXISTS catalog_assets (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS asset_trusts (asset_id TEXT NOT NULL, address TEXT NOT NULL, PRIMARY KEY(asset_id, address));
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        network TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(address, network, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, address TEXT NOT NULL, status TEXT NOT NULL, lease_expires_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        network TEXT NOT NULL,
        id TEXT NOT NULL,
        idempotency_key TEXT,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wallet_backups (backup_id TEXT PRIMARY KEY, write_token_hash TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS base_shields (key TEXT PRIMARY KEY, desk_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS health_checks (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_operations_address ON operations(address, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_actions_claim ON actions(address, status, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_events_address_cursor ON events(address, cursor);
      CREATE INDEX IF NOT EXISTS idx_activity_addr_network_cursor ON activity_events(address, network, cursor);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_addr_network_idem ON activity_events(address, network, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_addr_network_id ON activity_events(address, network, id);
      CREATE INDEX IF NOT EXISTS idx_base_shields_desk ON base_shields(desk_id);
    `);
    this.migrate();
    const existing = this.db.prepare("SELECT COUNT(*) AS count FROM catalog_assets").get() as { count: number };
    if (existing.count === 0) {
      const stmt = this.db.prepare("INSERT INTO catalog_assets(id, json) VALUES(?, ?)");
      for (const asset of defaultCatalog(now())) stmt.run(asset.id, JSON.stringify(asset));
    }
  }

  private migrate(): void {
    const alters = [
      "ALTER TABLE challenges ADD COLUMN network TEXT NOT NULL DEFAULT 'testnet'",
      "ALTER TABLE challenges ADD COLUMN audience TEXT NOT NULL DEFAULT 'mosaic-mcp'",
      "ALTER TABLE challenges ADD COLUMN issued_at INTEGER NOT NULL DEFAULT 0",
    ];
    for (const sql of alters) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists. SQLite has no `ADD COLUMN IF NOT EXISTS`.
      }
    }
    this.db.exec("PRAGMA user_version = 1");
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors and rethrow the original failure.
      }
      throw error;
    }
  }

  async createChallenge(address: string, message: string, network = "testnet", audience = "mosaic-mcp"): Promise<StoredChallenge> {
    const issued_at = now();
    const challenge = { id: randomUUID(), address, network, audience, message, issued_at, expires_at: issued_at + CHALLENGE_TTL_MS };
    this.db.prepare("INSERT INTO challenges(id, address, network, audience, message, issued_at, expires_at) VALUES(?, ?, ?, ?, ?, ?, ?)").run(
      challenge.id,
      challenge.address,
      challenge.network,
      challenge.audience,
      challenge.message,
      challenge.issued_at,
      challenge.expires_at,
    );
    return clone(challenge);
  }

  async consumeChallenge(id: string, address: string): Promise<StoredChallenge> {
    const challenge = this.db.prepare("SELECT id, address, network, audience, message, issued_at, expires_at FROM challenges WHERE id = ?").get(id) as
      | StoredChallenge
      | undefined;
    if (!challenge || challenge.address !== address || challenge.expires_at < now()) {
      throw new Error("unknown or expired challenge");
    }
    this.db.prepare("DELETE FROM challenges WHERE id = ?").run(id);
    return clone(challenge);
  }

  async createSession(address: string, network: string): Promise<{ token: string; session: AuthSession }> {
    const token = randomBytes(32).toString("hex");
    const session = { address, network, expires_at: now() + SESSION_TTL_MS };
    const stored: StoredSession = { ...session, token_hash: tokenHash(token) };
    this.db.prepare("INSERT INTO sessions(token_hash, json, expires_at) VALUES(?, ?, ?)").run(
      stored.token_hash,
      JSON.stringify(stored),
      session.expires_at,
    );
    return { token, session: clone(session) };
  }

  async getSession(token: string): Promise<AuthSession | null> {
    const session = parseJson<StoredSession>(
      this.db.prepare("SELECT json FROM sessions WHERE token_hash = ?").get(tokenHash(token)) as { json: string } | undefined,
    );
    if (!session || (session.expires_at !== undefined && session.expires_at < now())) return null;
    return { address: session.address, network: session.network, expires_at: session.expires_at };
  }

  async deleteSession(token: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
  }

  async listDesks(): Promise<Desk[]> {
    return (this.db.prepare("SELECT json FROM desks ORDER BY rowid").all() as { json: string }[]).map((row) =>
      JSON.parse(row.json) as Desk,
    );
  }

  async getDesk(id: string): Promise<Desk> {
    const desk = parseJson<Desk>(this.db.prepare("SELECT json FROM desks WHERE id = ?").get(id) as { json: string } | undefined);
    if (!desk) throw new Error(`desk ${id} not found`);
    return clone(desk);
  }

  async insertDesk(desk: Desk, sponsorSecret?: string | null): Promise<Desk> {
    this.db
      .prepare(
        "INSERT INTO desks(id, json, sponsor_secret) VALUES(?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET json = excluded.json, sponsor_secret = COALESCE(excluded.sponsor_secret, desks.sponsor_secret)",
      )
      .run(desk.id, JSON.stringify(desk), sponsorSecret ? protectSecret(sponsorSecret) : null);
    return clone(desk);
  }

  async sponsorSecret(deskId: string): Promise<string | null> {
    const row = this.db.prepare("SELECT sponsor_secret FROM desks WHERE id = ?").get(deskId) as
      | { sponsor_secret: string | null }
      | undefined;
    return row?.sponsor_secret ? revealSecret(row.sponsor_secret) : null;
  }

  async listAssets(address?: string): Promise<CatalogAsset[]> {
    const assets = (this.db.prepare("SELECT json FROM catalog_assets").all() as { json: string }[]).map((row) =>
      JSON.parse(row.json) as CatalogAsset,
    );
    return assets.map((asset) => {
      const trusted = this.db.prepare("SELECT address FROM asset_trusts WHERE asset_id = ?").all(asset.id) as { address: string }[];
      return {
        ...asset,
        trust_count: trusted.length,
        trusted_by_me: asset.is_default || (!!address && trusted.some((row) => row.address === address)),
      };
    });
  }

  async proposeAsset(body: Partial<CatalogAsset>, proposer: string): Promise<CatalogAsset> {
    const asset: CatalogAsset = {
      id: randomUUID(),
      symbol: String(body.symbol ?? "").trim().toUpperCase(),
      stellar_token: body.stellar_token ?? null,
      stellar_decimals: body.stellar_decimals ?? null,
      base_chain_id: body.base_chain_id ?? null,
      base_token: body.base_token ?? null,
      base_decimals: body.base_decimals ?? null,
      proposer_address: proposer,
      is_default: false,
      created_at: now(),
      trust_count: 0,
      trusted_by_me: true,
    };
    if (!asset.symbol) throw new Error("symbol required");
    this.db.prepare("INSERT INTO catalog_assets(id, json) VALUES(?, ?)").run(asset.id, JSON.stringify(asset));
    await this.setTrust(asset.id, proposer, true);
    return clone((await this.listAssets(proposer)).find((item) => item.id === asset.id)!);
  }

  async setTrust(assetId: string, address: string, trusted: boolean): Promise<{ ok: boolean }> {
    const asset = this.db.prepare("SELECT id FROM catalog_assets WHERE id = ?").get(assetId);
    if (!asset) throw new Error(`asset ${assetId} not found`);
    if (trusted) {
      this.db.prepare("INSERT OR IGNORE INTO asset_trusts(asset_id, address) VALUES(?, ?)").run(assetId, address);
    } else {
      this.db.prepare("DELETE FROM asset_trusts WHERE asset_id = ? AND address = ?").run(assetId, address);
    }
    return { ok: true };
  }

  async createOperation(address: string, network: string, request: OperationRequest, idempotencyKey: string): Promise<Operation> {
    return this.transaction(() => {
      const existing = this.db
        .prepare("SELECT id FROM operations WHERE address = ? AND network = ? AND idempotency_key = ?")
        .get(address, network, idempotencyKey) as { id: string } | undefined;
      if (existing) {
        const operation = parseJson<Operation>(
          this.db.prepare("SELECT json FROM operations WHERE id = ? AND address = ?").get(existing.id, address) as { json: string } | undefined,
        );
        if (!operation) throw new MosaicMcpError("NOT_FOUND", `operation ${existing.id} not found`);
        return clone(operation);
      }
      const operation: Operation = {
        id: randomUUID(),
        address,
        network,
        desk_id: request.desk_id,
        kind: request.kind,
        request,
        status: "waiting_for_client",
        created_at: now(),
        updated_at: now(),
        error: null,
        submitted: false,
      };
      const action: StoredAction = {
        id: randomUUID(),
        operation_id: operation.id,
        kind: operation.kind,
        payload: request,
        lease_token: "",
        lease_expires_at: 0,
        address,
        status: "available",
      };
      this.db.prepare("INSERT INTO operations(id, address, network, idempotency_key, json, created_at) VALUES(?, ?, ?, ?, ?, ?)").run(
        operation.id,
        address,
        network,
        idempotencyKey,
        JSON.stringify(operation),
        operation.created_at,
      );
      this.putAction(action);
      this.addEvent(operation, "created", "waiting_for_client", "Operation queued for wallet action.", {});
      return clone(operation);
    });
  }

  async listOperations(address: string): Promise<Operation[]> {
    return (this.db.prepare("SELECT json FROM operations WHERE address = ? ORDER BY created_at DESC").all(address) as { json: string }[]).map(
      (row) => JSON.parse(row.json) as Operation,
    );
  }

  async getOperation(address: string, id: string): Promise<Operation> {
    return clone(this.getOperationSync(address, id));
  }

  async cancelOperation(address: string, id: string): Promise<Operation> {
    return this.transaction(() => {
      const operation = this.getOperationSync(address, id);
      if (operation.status !== "succeeded" && operation.status !== "failed") {
        operation.status = "cancelled";
        operation.updated_at = now();
        this.putOperation(operation);
        this.addEvent(operation, "cancelled", "cancelled", "Operation cancelled.", {});
      }
      return clone(operation);
    });
  }

  async claimAction(address: string): Promise<ClientAction | null> {
    return this.transaction(() => {
      const actions = (this.db.prepare("SELECT id, status, lease_expires_at, json FROM actions WHERE address = ?").all(address) as {
        id: string;
        status: string;
        lease_expires_at: number;
        json: string;
      }[])
        .map((row) => JSON.parse(row.json) as StoredAction)
        .filter((item) => actionClaimable(item, this.operationForAction(item)))
        .sort((a, b) => this.operationCreatedAt(a.operation_id) - this.operationCreatedAt(b.operation_id));
      const action = actions[0];
      if (!action) return null;
      action.status = "leased";
      action.lease_token = randomBytes(32).toString("hex");
      action.lease_expires_at = now() + LEASE_TTL_MS;
      const result = this.db
        .prepare(
          "UPDATE actions SET status = ?, lease_expires_at = ?, json = ? WHERE id = ? AND address = ? AND (status = 'available' OR (status = 'leased' AND lease_expires_at < ?))",
        )
        .run(action.status, action.lease_expires_at, JSON.stringify(action), action.id, address, now());
      if (Number(result.changes) !== 1) return null;
      return clone(action);
    });
  }

  async heartbeatAction(address: string, id: string, leaseToken: string): Promise<{ lease_expires_at: number }> {
    const { action } = await this.validateActionLease(address, id, leaseToken);
    action.lease_expires_at = now() + LEASE_TTL_MS;
    this.putAction({ ...action, address, status: "leased" });
    return { lease_expires_at: action.lease_expires_at };
  }

  async validateActionLease(address: string, id: string, leaseToken: string): Promise<{ operation: Operation; action: ClientAction }> {
    return this.validateActionLeaseSync(address, id, leaseToken);
  }

  private validateActionLeaseSync(address: string, id: string, leaseToken: string): { operation: Operation; action: StoredAction } {
    const action = parseJson<StoredAction>(
      this.db.prepare("SELECT json FROM actions WHERE id = ?").get(id) as { json: string } | undefined,
    );
    if (!action || action.address !== address || action.lease_token !== leaseToken || action.lease_expires_at < now()) {
      throw new MosaicMcpError("LEASE_EXPIRED", "invalid or expired client action lease");
    }
    return { operation: this.getOperationSync(address, action.operation_id), action: clone(action) };
  }

  async completeAction(address: string, id: string, leaseToken: string, result: unknown): Promise<Operation> {
    return this.transaction(() => {
      const { operation, action } = this.validateActionLeaseSync(address, id, leaseToken);
      operation.status = "succeeded";
      operation.updated_at = now();
      operation.submitted = true;
      this.putOperation(operation);
      this.putAction({ ...action, address, status: "complete", result });
      this.addEvent(operation, "succeeded", "succeeded", "Operation succeeded.", result);
      return clone(operation);
    });
  }

  async failAction(address: string, id: string, leaseToken: string, error: string, retryable: boolean): Promise<Operation> {
    return this.transaction(() => {
      const { operation, action } = this.validateActionLeaseSync(address, id, leaseToken);
      operation.status = retryable ? "waiting_for_client" : "failed";
      operation.error = error;
      operation.updated_at = now();
      this.putOperation(operation);
      this.putAction({ ...action, address, status: retryable ? "available" : "failed" });
      this.addEvent(operation, "failed", operation.status, error, { retryable });
      return clone(operation);
    });
  }

  async eventsAfter(address: string, cursor: number): Promise<OperationEvent[]> {
    const rows = this.db.prepare("SELECT json FROM events WHERE address = ? AND cursor > ? ORDER BY cursor").all(address, cursor) as {
      json: string;
    }[];
    return rows.map((row) => JSON.parse(row.json) as OperationEvent);
  }

  async recordActivity(address: string, network: string, events: ActivityEvent[]): Promise<ActivityEvent[]> {
    return events.map((event) => this.recordOneActivity(address, network, event));
  }

  async activityAfter(address: string, network: string, cursor: number): Promise<ActivityEvent[]> {
    const rows = this.db
      .prepare("SELECT cursor, json FROM activity_events WHERE address = ? AND network = ? AND cursor > ? ORDER BY cursor")
      .all(address, network, cursor) as { cursor: number; json: string }[];
    return rows.map((row) => this.activityFromRow(row));
  }

  async getWalletBackup(backupId: string): Promise<WalletBackupEnvelope | null> {
    const backup = parseJson<StoredBackup>(
      this.db.prepare("SELECT json FROM wallet_backups WHERE backup_id = ?").get(backupId) as { json: string } | undefined,
    );
    if (!backup) return null;
    const { write_token_hash: _writeTokenHash, read_token_hash: _readTokenHash, owner_address: _ownerAddress, ...envelope } = backup;
    return clone(envelope);
  }

  async putWalletBackup(
    backupId: string,
    writeToken: string,
    readToken: string | undefined,
    expectedGeneration: number,
    envelope: WalletBackupEnvelope,
    ownerAddress?: string,
  ): Promise<{ generation: number }> {
    return this.transaction(() => {
      const existing = parseJson<StoredBackup>(
        this.db.prepare("SELECT json FROM wallet_backups WHERE backup_id = ?").get(backupId) as { json: string } | undefined,
      );
      if (existing && existing.generation !== expectedGeneration) throw new MosaicMcpError("CONFLICT", "backup generation conflict");
      if (existing && existing.write_token_hash !== tokenHash(writeToken)) throw new MosaicMcpError("AUTH_INVALID", "backup write token mismatch");
      const generation = expectedGeneration + 1;
      // A tokenless/sessionless update must not drop an existing read credential (that would turn a
      // protected backup world-readable): fall back to the stored hash / owner when not re-supplied.
      const stored: StoredBackup = {
        ...envelope,
        generation,
        write_token_hash: tokenHash(writeToken),
        read_token_hash: readToken ? tokenHash(readToken) : existing?.read_token_hash ?? null,
        owner_address: ownerAddress ?? existing?.owner_address ?? null,
      };
      this.db
        .prepare(
          "INSERT INTO wallet_backups(backup_id, write_token_hash, json) VALUES(?, ?, ?) " +
            "ON CONFLICT(backup_id) DO UPDATE SET write_token_hash = excluded.write_token_hash, json = excluded.json",
        )
        .run(backupId, stored.write_token_hash, JSON.stringify(stored));
      return { generation };
    });
  }

  async getWalletBackupForRead(backupId: string, readToken?: string, address?: string): Promise<WalletBackupEnvelope | null> {
    const backup = parseJson<StoredBackup>(
      this.db.prepare("SELECT json FROM wallet_backups WHERE backup_id = ?").get(backupId) as { json: string } | undefined,
    );
    if (!backup) return null;
    authorizeBackupRead(backup, readToken, address);
    const { write_token_hash: _writeTokenHash, read_token_hash: _readTokenHash, owner_address: _ownerAddress, ...envelope } = backup;
    return clone(envelope);
  }

  async enqueueBaseShield(deskId: string, bridge: string, depositId: number, ownerAddress: string, deposit?: BaseShieldDeposit): Promise<BaseShieldJob> {
    await assertBridgeMatches(this, deskId, bridge);
    const key = `${deskId}\0${bridge}\0${depositId}`;
    return this.transaction(() => {
      const existing = parseJson<BaseShieldJob>(
        this.db.prepare("SELECT json FROM base_shields WHERE key = ?").get(key) as { json: string } | undefined,
      );
      if (existing) return clone(existing);
      const job: BaseShieldJob = {
        id: randomUUID(),
        desk_id: deskId,
        owner_address: ownerAddress,
        bridge,
        deposit_id: depositId,
        status: "proving",
        version: 0,
        locked_by: null,
        lock_expires_at: null,
        block_number: null,
        block_hash: null,
        deposit,
        error: null,
        failure: null,
      };
      this.db.prepare("INSERT INTO base_shields(key, desk_id, json) VALUES(?, ?, ?)").run(key, deskId, JSON.stringify(job));
      return clone(job);
    });
  }

  async listBaseShields(deskId: string, ownerAddress?: string): Promise<BaseShieldJob[]> {
    return (this.db.prepare("SELECT json FROM base_shields WHERE desk_id = ?").all(deskId) as { json: string }[]).map(
      (row) => JSON.parse(row.json) as BaseShieldJob,
    ).filter((job) => !ownerAddress || !job.owner_address || job.owner_address === ownerAddress);
  }

  async retryBaseShield(id: string, ownerAddress?: string): Promise<BaseShieldJob> {
    return this.transaction(() => {
      const row = this.baseShieldRowById(id);
      if (!row) throw new MosaicMcpError("NOT_FOUND", `base-shield job ${id} not found`);
      if (ownerAddress && row.job.owner_address && row.job.owner_address !== ownerAddress) throw new MosaicMcpError("AUTH_INVALID", "base-shield job owner mismatch");
      if (row.job.status !== "failed") return clone(row.job);
      const job: BaseShieldJob = { ...row.job, status: resumeStatusForRetry(row.job), version: (row.job.version ?? 0) + 1 };
      resetRetryState(job);
      this.writeBaseShield(row.key, job);
      return clone(job);
    });
  }

  private baseShieldRowById(id: string): { key: string; job: BaseShieldJob } | undefined {
    // base_shields is keyed by (desk, bridge, deposit); look a job up by its id (small table). The
    // key is reconstructed from the job fields rather than the read-back `key` column, which
    // node:sqlite truncates at the embedded NUL separator (the stored/bound value is intact).
    const rows = this.db.prepare("SELECT json FROM base_shields").all() as { json: string }[];
    for (const row of rows) {
      const job = JSON.parse(row.json) as BaseShieldJob;
      if (job.id === id) return { key: `${job.desk_id}\0${job.bridge}\0${job.deposit_id}`, job };
    }
    return undefined;
  }

  private writeBaseShield(key: string, job: BaseShieldJob): void {
    this.db.prepare("UPDATE base_shields SET json = ? WHERE key = ?").run(JSON.stringify(job), key);
  }

  async nextBaseShields(): Promise<BaseShieldJob[]> {
    // Oldest first: rowid is monotonic in insertion order. Filter to the active stages in SQL so
    // the ever-growing set of terminal jobs (with their large seal/journal blobs) is never
    // fetched or parsed.
    const placeholders = BASE_SHIELD_STAGES.map(() => "?").join(", ");
    return this.transaction(() => {
      const rows = this.db
        .prepare(`SELECT json FROM base_shields WHERE json_extract(json, '$.status') IN (${placeholders}) ORDER BY rowid ASC`)
        .all(...BASE_SHIELD_STAGES) as { json: string }[];
      const worker = randomUUID();
      const deadline = now() + baseShieldLeaseTtlMs();
      const jobs = oldestBaseShieldPerStage(
        rows
          .map((row) => JSON.parse(row.json) as BaseShieldJob)
          .filter((job) => !job.lock_expires_at || job.lock_expires_at < now()),
      );
      const claimed: BaseShieldJob[] = [];
      for (const current of jobs) {
        const key = `${current.desk_id}\0${current.bridge}\0${current.deposit_id}`;
        const next: BaseShieldJob = { ...current, locked_by: worker, lock_expires_at: deadline, version: (current.version ?? 0) + 1 };
        const result = this.db.prepare("UPDATE base_shields SET json = ? WHERE key = ? AND json = ?").run(
          JSON.stringify(next),
          key,
          JSON.stringify(current),
        );
        if (Number(result.changes) === 1) claimed.push(next);
      }
      return claimed.map(clone);
    });
  }

  async baseShieldProved(
    id: string,
    blockNumber: number,
    blockHash: string,
    sealHex: string,
    journalHex: string,
    requireFinality: boolean,
  ): Promise<void> {
    this.transaction(() => {
      const row = this.baseShieldRowById(id);
      if (!row) throw new MosaicMcpError("NOT_FOUND", `base-shield job ${id} not found`);
      const job: BaseShieldJob = {
        ...row.job,
        status: requireFinality ? "awaiting_finality" : "minting",
        require_finality: requireFinality,
        version: (row.job.version ?? 0) + 1,
        block_number: blockNumber,
        block_hash: blockHash,
        seal_hex: sealHex,
        journal_hex: journalHex,
      };
      resetRetryState(job);
      this.writeBaseShield(row.key, job);
    });
  }

  async baseShieldStatus(id: string, status: string, stellarTxHash?: string): Promise<void> {
    this.transaction(() => {
      const row = this.baseShieldRowById(id);
      if (!row) throw new MosaicMcpError("NOT_FOUND", `base-shield job ${id} not found`);
      const job: BaseShieldJob = { ...row.job, status, version: (row.job.version ?? 0) + 1, ...(stellarTxHash ? { stellar_tx_hash: stellarTxHash } : {}) };
      resetRetryState(job);
      this.writeBaseShield(row.key, job);
    });
  }

  async baseShieldRelease(id: string): Promise<void> {
    this.transaction(() => {
      const row = this.baseShieldRowById(id);
      if (!row) throw new MosaicMcpError("NOT_FOUND", `base-shield job ${id} not found`);
      this.writeBaseShield(row.key, { ...row.job, locked_by: null, lock_expires_at: null, version: (row.job.version ?? 0) + 1 });
    });
  }

  async baseShieldRetry(id: string, error: string, failure?: MosaicMcpErrorBody): Promise<void> {
    this.transaction(() => {
      const row = this.baseShieldRowById(id);
      if (!row) throw new MosaicMcpError("NOT_FOUND", `base-shield job ${id} not found`);
      bumpRetryState(row.job, error);
      row.job.failure = failure ?? classifyMcpError(error).body();
      row.job.locked_by = null;
      row.job.lock_expires_at = null;
      row.job.version = (row.job.version ?? 0) + 1;
      this.writeBaseShield(row.key, row.job);
    });
  }

  async baseShieldFailed(id: string, error: string, failure?: MosaicMcpErrorBody): Promise<void> {
    this.transaction(() => {
      const row = this.baseShieldRowById(id);
      if (!row) throw new MosaicMcpError("NOT_FOUND", `base-shield job ${id} not found`);
      this.writeBaseShield(row.key, {
        ...row.job,
        status: "failed",
        version: (row.job.version ?? 0) + 1,
        locked_by: null,
        lock_expires_at: null,
        error,
        failure: failure ?? classifyMcpError(error).body(),
      });
    });
  }

  private putOperation(operation: Operation): void {
    this.db.prepare("UPDATE operations SET json = ? WHERE id = ?").run(JSON.stringify(operation), operation.id);
  }

  private getOperationSync(address: string, id: string): Operation {
    const operation = parseJson<Operation>(
      this.db.prepare("SELECT json FROM operations WHERE id = ? AND address = ?").get(id, address) as { json: string } | undefined,
    );
    if (!operation) throw new MosaicMcpError("NOT_FOUND", `operation ${id} not found`);
    return operation;
  }

  private putAction(action: StoredAction): void {
    this.db
      .prepare(
        "INSERT INTO actions(id, address, status, lease_expires_at, json) VALUES(?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET address = excluded.address, status = excluded.status, " +
          "lease_expires_at = excluded.lease_expires_at, json = excluded.json",
      )
      .run(action.id, action.address, action.status, action.lease_expires_at, JSON.stringify(action));
  }

  private operationCreatedAt(id: string): number {
    const row = this.db.prepare("SELECT created_at FROM operations WHERE id = ?").get(id) as { created_at: number } | undefined;
    return row?.created_at ?? 0;
  }

  private operationForAction(action: StoredAction): Operation | undefined {
    return parseJson<Operation>(
      this.db.prepare("SELECT json FROM operations WHERE id = ? AND address = ?").get(action.operation_id, action.address) as
        | { json: string }
        | undefined,
    );
  }

  private addEvent(operation: Operation, event_type: string, state: string, message: string, details: unknown): void {
    const event = {
      cursor: 0,
      operation_id: operation.id,
      event_type,
      state,
      message,
      details,
      created_at: now(),
    };
    const result = this.db.prepare("INSERT INTO events(address, json) VALUES(?, ?)").run(operation.address, JSON.stringify(event));
    event.cursor = Number(result.lastInsertRowid);
    this.db.prepare("UPDATE events SET json = ? WHERE cursor = ?").run(JSON.stringify(event), event.cursor);
  }

  private recordOneActivity(address: string, network: string, event: ActivityEvent): ActivityEvent {
    const stored = normalizeActivityEvent({ ...event, wallet_address: address, network });
    if (!stored.id) throw new Error("activity event id required");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO activity_events(address, network, id, idempotency_key, json, created_at) VALUES(?, ?, ?, ?, ?, ?)",
      )
      .run(address, network, stored.id, stored.idempotency_key ?? null, JSON.stringify(stored), stored.created_at ?? now());
    const row = this.activityRow(address, network, stored.id, stored.idempotency_key);
    if (!row) throw new Error("failed to record activity event");
    const withCursor = this.activityFromRow(row);
    if ((stored.cursor ?? 0) !== withCursor.cursor) {
      this.db.prepare("UPDATE activity_events SET json = ? WHERE cursor = ?").run(JSON.stringify(withCursor), withCursor.cursor ?? row.cursor);
    }
    return withCursor;
  }

  private activityRow(
    address: string,
    network: string,
    id: string,
    idempotencyKey?: string,
  ): { cursor: number; json: string } | undefined {
    if (idempotencyKey) {
      const row = this.db
        .prepare("SELECT cursor, json FROM activity_events WHERE address = ? AND network = ? AND idempotency_key = ?")
        .get(address, network, idempotencyKey) as { cursor: number; json: string } | undefined;
      if (row) return row;
    }
    return this.db
      .prepare("SELECT cursor, json FROM activity_events WHERE address = ? AND network = ? AND id = ?")
      .get(address, network, id) as { cursor: number; json: string } | undefined;
  }

  private activityFromRow(row: { cursor: number; json: string }): ActivityEvent {
    return { ...(JSON.parse(row.json) as ActivityEvent), cursor: Number(row.cursor) };
  }

  async healthCheck(): Promise<{ ok: boolean; path?: string }> {
    // A real write probe (the worker needs a writable DB), but the table is created once at open —
    // no per-probe DDL. /readyz can poll this frequently without re-running CREATE TABLE each time.
    const key = `health-${randomUUID()}`;
    this.transaction(() => {
      this.db.prepare("INSERT INTO health_checks(id, created_at) VALUES(?, ?)").run(key, now());
      this.db.prepare("DELETE FROM health_checks WHERE id = ?").run(key);
    });
    return { ok: true, path: this.path };
  }
}

export function openMosaicStore(databaseUrl = "sqlite://./mosaic-mcp.db"): MosaicStore {
  return new SqliteMosaicStore(databaseUrl);
}
