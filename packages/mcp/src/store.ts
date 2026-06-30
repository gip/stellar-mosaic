import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AuthSession,
  BaseShieldJob,
  CatalogAsset,
  ClientAction,
  Desk,
  Operation,
  OperationEvent,
  OperationRequest,
  WalletBackupEnvelope,
} from "@mosaic/sdk";

const now = () => Date.now();
const SESSION_TTL_MS = 60 * 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const LEASE_TTL_MS = 90_000;

export interface StoredChallenge {
  id: string;
  address: string;
  message: string;
  expires_at: number;
}

interface StoredBackup extends WalletBackupEnvelope {
  write_token_hash: string;
}

export interface MosaicStore {
  createChallenge(address: string, message: string): Promise<StoredChallenge>;
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
  getWalletBackup(backupId: string): Promise<WalletBackupEnvelope | null>;
  putWalletBackup(
    backupId: string,
    writeToken: string,
    expectedGeneration: number,
    envelope: WalletBackupEnvelope,
  ): Promise<{ generation: number }>;
  enqueueBaseShield(deskId: string, bridge: string, depositId: number): Promise<BaseShieldJob>;
  listBaseShields(deskId: string): Promise<BaseShieldJob[]>;
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secretKey(): Buffer | null {
  const key = process.env.MOSAIC_SERVER_KEY;
  return key ? createHash("sha256").update(key).digest() : null;
}

function protectSecret(value: string): string {
  const key = secretKey();
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
  private readonly backups = new Map<string, StoredBackup>();
  private readonly baseShields = new Map<string, BaseShieldJob>();
  private cursor = 0;

  constructor() {
    for (const asset of defaultCatalog(now())) this.assets.set(asset.id, asset);
  }

  async createChallenge(address: string, message: string): Promise<StoredChallenge> {
    const challenge = { id: randomUUID(), address, message, expires_at: now() + CHALLENGE_TTL_MS };
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

  async getWalletBackup(backupId: string): Promise<WalletBackupEnvelope | null> {
    const backup = this.backups.get(backupId);
    if (!backup) return null;
    const { write_token_hash: _writeTokenHash, ...envelope } = backup;
    return clone(envelope);
  }

  async putWalletBackup(
    backupId: string,
    writeToken: string,
    expectedGeneration: number,
    envelope: WalletBackupEnvelope,
  ): Promise<{ generation: number }> {
    const existing = this.backups.get(backupId);
    if (existing && existing.generation !== expectedGeneration) throw new Error("backup generation conflict");
    if (existing && existing.write_token_hash !== tokenHash(writeToken)) throw new Error("backup write token mismatch");
    const generation = expectedGeneration + 1;
    this.backups.set(backupId, { ...envelope, generation, write_token_hash: tokenHash(writeToken) });
    return { generation };
  }

  async enqueueBaseShield(deskId: string, bridge: string, depositId: number): Promise<BaseShieldJob> {
    const key = `${deskId}\0${bridge}\0${depositId}`;
    const existing = this.baseShields.get(key);
    if (existing) return clone(existing);
    const job: BaseShieldJob = {
      id: randomUUID(),
      desk_id: deskId,
      bridge,
      deposit_id: depositId,
      status: "proving",
      block_number: null,
      block_hash: null,
      error: null,
    };
    this.baseShields.set(key, job);
    return clone(job);
  }

  async listBaseShields(deskId: string): Promise<BaseShieldJob[]> {
    return [...this.baseShields.values()].filter((job) => job.desk_id === deskId).map(clone);
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

export class SqliteMosaicStore implements MosaicStore {
  private readonly db: DatabaseSync;

  constructor(databaseUrl = "sqlite://./mosaic-mcp.db") {
    const path = sqlitePath(databaseUrl);
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, address TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL);
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
      CREATE TABLE IF NOT EXISTS wallet_backups (backup_id TEXT PRIMARY KEY, write_token_hash TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS base_shields (key TEXT PRIMARY KEY, desk_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_operations_address ON operations(address, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_actions_claim ON actions(address, status, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_events_address_cursor ON events(address, cursor);
      CREATE INDEX IF NOT EXISTS idx_base_shields_desk ON base_shields(desk_id);
    `);
    const existing = this.db.prepare("SELECT COUNT(*) AS count FROM catalog_assets").get() as { count: number };
    if (existing.count === 0) {
      const stmt = this.db.prepare("INSERT INTO catalog_assets(id, json) VALUES(?, ?)");
      for (const asset of defaultCatalog(now())) stmt.run(asset.id, JSON.stringify(asset));
    }
  }

  async createChallenge(address: string, message: string): Promise<StoredChallenge> {
    const challenge = { id: randomUUID(), address, message, expires_at: now() + CHALLENGE_TTL_MS };
    this.db.prepare("INSERT INTO challenges(id, address, message, expires_at) VALUES(?, ?, ?, ?)").run(
      challenge.id,
      challenge.address,
      challenge.message,
      challenge.expires_at,
    );
    return clone(challenge);
  }

  async consumeChallenge(id: string, address: string): Promise<StoredChallenge> {
    const challenge = this.db.prepare("SELECT id, address, message, expires_at FROM challenges WHERE id = ?").get(id) as
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
    const existing = this.db
      .prepare("SELECT id FROM operations WHERE address = ? AND network = ? AND idempotency_key = ?")
      .get(address, network, idempotencyKey) as { id: string } | undefined;
    if (existing) return this.getOperation(address, existing.id);
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
  }

  async listOperations(address: string): Promise<Operation[]> {
    return (this.db.prepare("SELECT json FROM operations WHERE address = ? ORDER BY created_at DESC").all(address) as { json: string }[]).map(
      (row) => JSON.parse(row.json) as Operation,
    );
  }

  async getOperation(address: string, id: string): Promise<Operation> {
    const operation = parseJson<Operation>(
      this.db.prepare("SELECT json FROM operations WHERE id = ? AND address = ?").get(id, address) as { json: string } | undefined,
    );
    if (!operation) throw new Error(`operation ${id} not found`);
    return clone(operation);
  }

  async cancelOperation(address: string, id: string): Promise<Operation> {
    const operation = await this.getOperation(address, id);
    if (operation.status !== "succeeded" && operation.status !== "failed") {
      operation.status = "cancelled";
      operation.updated_at = now();
      this.putOperation(operation);
      this.addEvent(operation, "cancelled", "cancelled", "Operation cancelled.", {});
    }
    return clone(operation);
  }

  async claimAction(address: string): Promise<ClientAction | null> {
    const actions = (this.db.prepare("SELECT json FROM actions WHERE address = ?").all(address) as { json: string }[])
      .map((row) => JSON.parse(row.json) as StoredAction)
      .filter((item) => actionClaimable(item, this.operationForAction(item)))
      .sort((a, b) => this.operationCreatedAt(a.operation_id) - this.operationCreatedAt(b.operation_id));
    const action = actions[0];
    if (!action) return null;
    action.status = "leased";
    action.lease_token = randomBytes(32).toString("hex");
    action.lease_expires_at = now() + LEASE_TTL_MS;
    this.putAction(action);
    return clone(action);
  }

  async heartbeatAction(address: string, id: string, leaseToken: string): Promise<{ lease_expires_at: number }> {
    const { action } = await this.validateActionLease(address, id, leaseToken);
    action.lease_expires_at = now() + LEASE_TTL_MS;
    this.putAction({ ...action, address, status: "leased" });
    return { lease_expires_at: action.lease_expires_at };
  }

  async validateActionLease(address: string, id: string, leaseToken: string): Promise<{ operation: Operation; action: ClientAction }> {
    const action = parseJson<StoredAction>(
      this.db.prepare("SELECT json FROM actions WHERE id = ?").get(id) as { json: string } | undefined,
    );
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
    this.putOperation(operation);
    this.putAction({ ...action, address, status: "complete", result });
    this.addEvent(operation, "succeeded", "succeeded", "Operation succeeded.", result);
    return clone(operation);
  }

  async failAction(address: string, id: string, leaseToken: string, error: string, retryable: boolean): Promise<Operation> {
    const { operation, action } = await this.validateActionLease(address, id, leaseToken);
    operation.status = retryable ? "waiting_for_client" : "failed";
    operation.error = error;
    operation.updated_at = now();
    this.putOperation(operation);
    this.putAction({ ...action, address, status: retryable ? "available" : "failed" });
    this.addEvent(operation, "failed", operation.status, error, { retryable });
    return clone(operation);
  }

  async eventsAfter(address: string, cursor: number): Promise<OperationEvent[]> {
    const rows = this.db.prepare("SELECT json FROM events WHERE address = ? AND cursor > ? ORDER BY cursor").all(address, cursor) as {
      json: string;
    }[];
    return rows.map((row) => JSON.parse(row.json) as OperationEvent);
  }

  async getWalletBackup(backupId: string): Promise<WalletBackupEnvelope | null> {
    const backup = parseJson<StoredBackup>(
      this.db.prepare("SELECT json FROM wallet_backups WHERE backup_id = ?").get(backupId) as { json: string } | undefined,
    );
    if (!backup) return null;
    const { write_token_hash: _writeTokenHash, ...envelope } = backup;
    return clone(envelope);
  }

  async putWalletBackup(
    backupId: string,
    writeToken: string,
    expectedGeneration: number,
    envelope: WalletBackupEnvelope,
  ): Promise<{ generation: number }> {
    const existing = parseJson<StoredBackup>(
      this.db.prepare("SELECT json FROM wallet_backups WHERE backup_id = ?").get(backupId) as { json: string } | undefined,
    );
    if (existing && existing.generation !== expectedGeneration) throw new Error("backup generation conflict");
    if (existing && existing.write_token_hash !== tokenHash(writeToken)) throw new Error("backup write token mismatch");
    const generation = expectedGeneration + 1;
    const stored = { ...envelope, generation, write_token_hash: tokenHash(writeToken) };
    this.db
      .prepare(
        "INSERT INTO wallet_backups(backup_id, write_token_hash, json) VALUES(?, ?, ?) " +
          "ON CONFLICT(backup_id) DO UPDATE SET write_token_hash = excluded.write_token_hash, json = excluded.json",
      )
      .run(backupId, stored.write_token_hash, JSON.stringify(stored));
    return { generation };
  }

  async enqueueBaseShield(deskId: string, bridge: string, depositId: number): Promise<BaseShieldJob> {
    const key = `${deskId}\0${bridge}\0${depositId}`;
    const existing = parseJson<BaseShieldJob>(
      this.db.prepare("SELECT json FROM base_shields WHERE key = ?").get(key) as { json: string } | undefined,
    );
    if (existing) return clone(existing);
    const job: BaseShieldJob = {
      id: randomUUID(),
      desk_id: deskId,
      bridge,
      deposit_id: depositId,
      status: "proving",
      block_number: null,
      block_hash: null,
      error: null,
    };
    this.db.prepare("INSERT INTO base_shields(key, desk_id, json) VALUES(?, ?, ?)").run(key, deskId, JSON.stringify(job));
    return clone(job);
  }

  async listBaseShields(deskId: string): Promise<BaseShieldJob[]> {
    return (this.db.prepare("SELECT json FROM base_shields WHERE desk_id = ?").all(deskId) as { json: string }[]).map(
      (row) => JSON.parse(row.json) as BaseShieldJob,
    );
  }

  private putOperation(operation: Operation): void {
    this.db.prepare("UPDATE operations SET json = ? WHERE id = ?").run(JSON.stringify(operation), operation.id);
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
}

export function openMosaicStore(databaseUrl = "sqlite://./mosaic-mcp.db"): MosaicStore {
  return new SqliteMosaicStore(databaseUrl);
}
