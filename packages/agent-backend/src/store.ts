// Persistence for the agent backend, copying the MCP store's shape (packages/mcp/src/store.ts):
// one `AgentStore` interface with a `MemoryAgentStore` / `SqliteAgentStore` twin, node:sqlite with
// WAL, JSON-blob rows next to the columns that need indexing, session tokens sha256-hashed at
// rest, and a `sqlite://` database URL. No `\0`-composite TEXT keys anywhere (node:sqlite
// truncates read-back TEXT at an embedded NUL).

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentIdentityDescriptor,
  AgentRecord,
  AgentSessionRecord,
  LogEntry,
  LogEnvelope,
  RunnerRecord,
  SealedRootEnvelope,
} from "@mosaic/agent-sdk";

const now = () => Date.now();
const SESSION_TTL_MS = 60 * 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
/** A second daemon presenting the same runner credential is refused while the first one's
 *  heartbeat is fresher than this. */
const HEARTBEAT_CONFLICT_MS = 60_000;
const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 1000;

/** Errors carry the HTTP status they map to; the router turns them into JSON error bodies. */
export class AgentBackendError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentBackendError";
  }
}

const err = (status: number, message: string) => new AgentBackendError(status, message);

export type SessionPayload =
  | { kind: "master"; master_id: string }
  | { kind: "runner"; runner_id: string; master_id: string }
  | { kind: "agent"; agent_id: string; session_id: string };

export type StoredSession = SessionPayload & { expires_at: number };

export interface StoredChallenge {
  id: string;
  /** Who may consume it, e.g. `master:stellar:G...`, `runner:<id>`, `agent:<G...>`. */
  subject: string;
  message: string;
  expires_at: number;
}

export interface MasterRecord {
  id: string;
  chain: "stellar" | "ethereum";
  address: string;
  created_at: number;
}

export interface AgentDataValue {
  value: unknown;
  updated_at: number;
  updated_by: string;
}

export type AgentDataKind = "attached" | "scratch";

export interface NewLogEntry {
  session_id: string;
  agent_id: string;
  seq: number;
  at: number;
  visibility: "public" | "private";
  kind: LogEnvelope["kind"];
  payload: unknown;
}

export interface LogFilter {
  sessionId?: string;
  agentId?: string;
  afterCursor?: number;
  limit?: number;
}

export interface AgentStore {
  // auth
  createChallenge(subject: string, message: string): Promise<StoredChallenge>;
  consumeChallenge(id: string, subject: string): Promise<StoredChallenge>;
  createSession(payload: SessionPayload): Promise<{ token: string; session: StoredSession }>;
  getSession(token: string): Promise<StoredSession | null>;
  deleteSession(token: string): Promise<void>;
  // masters
  upsertMaster(chain: "stellar" | "ethereum", address: string): Promise<MasterRecord>;
  // agents
  registerAgent(masterId: string, descriptor: AgentIdentityDescriptor): Promise<AgentRecord>;
  listAgents(masterId: string): Promise<AgentRecord[]>;
  getAgent(agentId: string): Promise<AgentRecord>;
  agentByStellarKey(stellarPublicKey: string): Promise<AgentRecord | null>;
  agentByEthAddress(ethAddress: string): Promise<AgentRecord | null>;
  revokeAgent(masterId: string, agentId: string): Promise<AgentRecord>;
  setDesiredState(masterId: string, agentId: string, state: "running" | "stopped"): Promise<AgentRecord>;
  // runners
  registerRunner(
    masterId: string,
    keys: { auth_public_key: string; seal_public_key: string; name?: string; runtime_version?: string },
  ): Promise<RunnerRecord>;
  listRunners(masterId: string): Promise<RunnerRecord[]>;
  getRunner(runnerId: string): Promise<RunnerRecord>;
  updateRunner(masterId: string, runnerId: string, patch: { name?: string; runtime_version?: string }): Promise<RunnerRecord>;
  revokeRunner(masterId: string, runnerId: string): Promise<RunnerRecord>;
  /** Record a daemon heartbeat; `conflict` is true when a *different* live instance already holds
   *  this runner (the caller should warn and exit rather than double-run agents). */
  heartbeatRunner(runnerId: string, instanceId: string): Promise<{ conflict: boolean }>;
  // sealed key bundles
  putSealedRoot(masterId: string, agentId: string, runnerId: string, envelope: SealedRootEnvelope): Promise<void>;
  sealedRoot(agentId: string, runnerId: string): Promise<SealedRootEnvelope | null>;
  // per-agent data
  putAgentData(agentId: string, kind: AgentDataKind, key: string, value: unknown, updatedBy: string): Promise<void>;
  deleteAgentData(agentId: string, kind: AgentDataKind, key: string): Promise<void>;
  agentData(agentId: string, kind: AgentDataKind): Promise<Record<string, AgentDataValue>>;
  // agent sessions + logs
  createAgentSession(agentId: string): Promise<AgentSessionRecord>;
  getAgentSession(sessionId: string): Promise<AgentSessionRecord | null>;
  endAgentSession(sessionId: string): Promise<void>;
  listAgentSessions(agentId: string): Promise<AgentSessionRecord[]>;
  /** Insert one log entry; returns null when (session_id, seq) already exists (idempotent under
   *  XMTP redelivery). */
  insertLogEntry(entry: NewLogEntry): Promise<LogEntry | null>;
  /** Entries of one session ordered by seq. `publicOnly` filters to public entries. */
  logsBySession(sessionId: string, opts?: { publicOnly?: boolean; afterSeq?: number }): Promise<LogEntry[]>;
  /** Public entries only, unauthenticated feed; ordered by arrival cursor. */
  publicLogs(filter: LogFilter): Promise<LogEntry[]>;
  /** All entries (private included) across one master's agents; ordered by arrival cursor. */
  masterLogs(masterId: string, filter: LogFilter): Promise<LogEntry[]>;
}

export function masterId(chain: "stellar" | "ethereum", address: string): string {
  return `${chain}:${chain === "ethereum" ? address.toLowerCase() : address}`;
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function newAgentRecord(masterIdValue: string, descriptor: AgentIdentityDescriptor): AgentRecord {
  return {
    id: randomUUID(),
    master_id: masterIdValue,
    index: descriptor.index,
    stellar_public_key: descriptor.stellar_public_key,
    eth_address: descriptor.eth_address.toLowerCase() as `0x${string}`,
    ...(descriptor.name !== undefined ? { name: descriptor.name } : {}),
    ...(descriptor.metadata !== undefined ? { metadata: descriptor.metadata } : {}),
    descriptor: clone(descriptor),
    desired_state: "stopped",
    revoked: false,
    created_at: now(),
  };
}

/** Registration is idempotent on an identical descriptor and a hard 409 on any mismatch: the same
 *  (master, index) must always present the same derived public keys, and a public key can belong
 *  to only one identity. */
function reconcileRegistration(
  descriptor: AgentIdentityDescriptor,
  byIndex: AgentRecord | undefined,
  byStellar: AgentRecord | null,
  byEth: AgentRecord | null,
): AgentRecord | undefined {
  if (byIndex) {
    if (
      byIndex.stellar_public_key === descriptor.stellar_public_key &&
      byIndex.eth_address === descriptor.eth_address.toLowerCase()
    ) {
      return byIndex;
    }
    throw err(409, `agent index ${descriptor.index} is already registered with different keys`);
  }
  if (byStellar || byEth) throw err(409, "public key already registered to another agent identity");
  return undefined;
}

function validateDescriptor(descriptor: AgentIdentityDescriptor): void {
  if (descriptor.derivation_version !== 1) throw err(400, "unsupported derivation_version");
  if (!Number.isInteger(descriptor.index) || descriptor.index < 0) throw err(400, "index must be a non-negative integer");
  if (typeof descriptor.stellar_public_key !== "string" || !descriptor.stellar_public_key.startsWith("G")) {
    throw err(400, "stellar_public_key must be a G... strkey");
  }
  if (typeof descriptor.eth_address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(descriptor.eth_address)) {
    throw err(400, "eth_address must be a 0x address");
  }
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LOG_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) throw err(400, "limit must be a positive integer");
  return Math.min(limit, MAX_LOG_LIMIT);
}

// ---------------------------------------------------------------------------
// In-memory twin
// ---------------------------------------------------------------------------

export class MemoryAgentStore implements AgentStore {
  private readonly challenges = new Map<string, StoredChallenge>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly masters = new Map<string, MasterRecord>();
  private readonly agents = new Map<string, AgentRecord>();
  private readonly runners = new Map<string, RunnerRecord>();
  private readonly sealedRoots = new Map<string, SealedRootEnvelope>(); // `${agentId}|${runnerId}`
  private readonly data = new Map<string, AgentDataValue>(); // `${agentId}|${kind}|${key}`
  private readonly agentSessions = new Map<string, AgentSessionRecord>();
  private readonly logs: LogEntry[] = [];
  private readonly logKeys = new Set<string>(); // `${session_id}|${seq}`
  private cursor = 0;

  async createChallenge(subject: string, message: string): Promise<StoredChallenge> {
    const challenge: StoredChallenge = { id: randomUUID(), subject, message, expires_at: now() + CHALLENGE_TTL_MS };
    this.challenges.set(challenge.id, challenge);
    return clone(challenge);
  }

  async consumeChallenge(id: string, subject: string): Promise<StoredChallenge> {
    const challenge = this.challenges.get(id);
    if (!challenge || challenge.subject !== subject || challenge.expires_at < now()) {
      throw err(401, "unknown or expired challenge");
    }
    this.challenges.delete(id);
    return clone(challenge);
  }

  async createSession(payload: SessionPayload): Promise<{ token: string; session: StoredSession }> {
    const token = randomBytes(32).toString("hex");
    const session: StoredSession = { ...payload, expires_at: now() + SESSION_TTL_MS };
    this.sessions.set(tokenHash(token), session);
    return { token, session: clone(session) };
  }

  async getSession(token: string): Promise<StoredSession | null> {
    const session = this.sessions.get(tokenHash(token));
    if (!session || session.expires_at < now()) return null;
    return clone(session);
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(tokenHash(token));
  }

  async upsertMaster(chain: "stellar" | "ethereum", address: string): Promise<MasterRecord> {
    const id = masterId(chain, address);
    const existing = this.masters.get(id);
    if (existing) return clone(existing);
    const record: MasterRecord = { id, chain, address: chain === "ethereum" ? address.toLowerCase() : address, created_at: now() };
    this.masters.set(id, record);
    return clone(record);
  }

  async registerAgent(masterIdValue: string, descriptor: AgentIdentityDescriptor): Promise<AgentRecord> {
    validateDescriptor(descriptor);
    const byIndex = [...this.agents.values()].find((a) => a.master_id === masterIdValue && a.index === descriptor.index);
    const existing = reconcileRegistration(
      descriptor,
      byIndex,
      await this.agentByStellarKey(descriptor.stellar_public_key),
      await this.agentByEthAddress(descriptor.eth_address),
    );
    if (existing) return clone(existing);
    const record = newAgentRecord(masterIdValue, descriptor);
    this.agents.set(record.id, record);
    return clone(record);
  }

  async listAgents(masterIdValue: string): Promise<AgentRecord[]> {
    return [...this.agents.values()]
      .filter((a) => a.master_id === masterIdValue)
      .sort((a, b) => a.index - b.index)
      .map(clone);
  }

  async getAgent(agentId: string): Promise<AgentRecord> {
    const agent = this.agents.get(agentId);
    if (!agent) throw err(404, `agent ${agentId} not found`);
    return clone(agent);
  }

  async agentByStellarKey(stellarPublicKey: string): Promise<AgentRecord | null> {
    const agent = [...this.agents.values()].find((a) => a.stellar_public_key === stellarPublicKey);
    return agent ? clone(agent) : null;
  }

  async agentByEthAddress(ethAddress: string): Promise<AgentRecord | null> {
    const agent = [...this.agents.values()].find((a) => a.eth_address === ethAddress.toLowerCase());
    return agent ? clone(agent) : null;
  }

  async revokeAgent(masterIdValue: string, agentId: string): Promise<AgentRecord> {
    const agent = await this.ownedAgent(masterIdValue, agentId);
    agent.revoked = true;
    agent.desired_state = "stopped";
    this.agents.set(agent.id, agent);
    return clone(agent);
  }

  async setDesiredState(masterIdValue: string, agentId: string, state: "running" | "stopped"): Promise<AgentRecord> {
    const agent = await this.ownedAgent(masterIdValue, agentId);
    if (agent.revoked && state === "running") throw err(409, "agent is revoked");
    agent.desired_state = state;
    this.agents.set(agent.id, agent);
    return clone(agent);
  }

  private async ownedAgent(masterIdValue: string, agentId: string): Promise<AgentRecord> {
    const agent = this.agents.get(agentId);
    if (!agent || agent.master_id !== masterIdValue) throw err(404, `agent ${agentId} not found`);
    return agent;
  }

  async registerRunner(
    masterIdValue: string,
    keys: { auth_public_key: string; seal_public_key: string; name?: string; runtime_version?: string },
  ): Promise<RunnerRecord> {
    const record: RunnerRecord = {
      id: randomUUID(),
      master_id: masterIdValue,
      ...(keys.name !== undefined ? { name: keys.name } : {}),
      auth_public_key: keys.auth_public_key,
      seal_public_key: keys.seal_public_key,
      runtime_version: keys.runtime_version ?? "latest",
      revoked: false,
      created_at: now(),
    };
    this.runners.set(record.id, record);
    return clone(record);
  }

  async listRunners(masterIdValue: string): Promise<RunnerRecord[]> {
    return [...this.runners.values()]
      .filter((r) => r.master_id === masterIdValue)
      .sort((a, b) => a.created_at - b.created_at)
      .map(clone);
  }

  async getRunner(runnerId: string): Promise<RunnerRecord> {
    const runner = this.runners.get(runnerId);
    if (!runner) throw err(404, `runner ${runnerId} not found`);
    return clone(runner);
  }

  async updateRunner(
    masterIdValue: string,
    runnerId: string,
    patch: { name?: string; runtime_version?: string },
  ): Promise<RunnerRecord> {
    const runner = await this.ownedRunner(masterIdValue, runnerId);
    if (patch.name !== undefined) runner.name = patch.name;
    if (patch.runtime_version !== undefined) runner.runtime_version = patch.runtime_version;
    this.runners.set(runner.id, runner);
    return clone(runner);
  }

  async revokeRunner(masterIdValue: string, runnerId: string): Promise<RunnerRecord> {
    const runner = await this.ownedRunner(masterIdValue, runnerId);
    runner.revoked = true;
    this.runners.set(runner.id, runner);
    return clone(runner);
  }

  async heartbeatRunner(runnerId: string, instanceId: string): Promise<{ conflict: boolean }> {
    const runner = this.runners.get(runnerId);
    if (!runner || runner.revoked) throw err(404, `runner ${runnerId} not found`);
    if (runner.instance_id && runner.instance_id !== instanceId && (runner.last_seen ?? 0) > now() - HEARTBEAT_CONFLICT_MS) {
      return { conflict: true };
    }
    runner.instance_id = instanceId;
    runner.last_seen = now();
    this.runners.set(runner.id, runner);
    return { conflict: false };
  }

  private async ownedRunner(masterIdValue: string, runnerId: string): Promise<RunnerRecord> {
    const runner = this.runners.get(runnerId);
    if (!runner || runner.master_id !== masterIdValue) throw err(404, `runner ${runnerId} not found`);
    return runner;
  }

  async putSealedRoot(masterIdValue: string, agentId: string, runnerId: string, envelope: SealedRootEnvelope): Promise<void> {
    await this.ownedAgent(masterIdValue, agentId);
    await this.ownedRunner(masterIdValue, runnerId);
    this.sealedRoots.set(`${agentId}|${runnerId}`, clone(envelope));
  }

  async sealedRoot(agentId: string, runnerId: string): Promise<SealedRootEnvelope | null> {
    const envelope = this.sealedRoots.get(`${agentId}|${runnerId}`);
    return envelope ? clone(envelope) : null;
  }

  async putAgentData(agentId: string, kind: AgentDataKind, key: string, value: unknown, updatedBy: string): Promise<void> {
    this.data.set(`${agentId}|${kind}|${key}`, { value: clone(value), updated_at: now(), updated_by: updatedBy });
  }

  async deleteAgentData(agentId: string, kind: AgentDataKind, key: string): Promise<void> {
    this.data.delete(`${agentId}|${kind}|${key}`);
  }

  async agentData(agentId: string, kind: AgentDataKind): Promise<Record<string, AgentDataValue>> {
    const out: Record<string, AgentDataValue> = {};
    const prefix = `${agentId}|${kind}|`;
    for (const [mapKey, stored] of this.data) {
      if (mapKey.startsWith(prefix)) out[mapKey.slice(prefix.length)] = clone(stored);
    }
    return out;
  }

  async createAgentSession(agentId: string): Promise<AgentSessionRecord> {
    const session: AgentSessionRecord = { id: randomUUID(), agent_id: agentId, started_at: now(), log_count: 0 };
    this.agentSessions.set(session.id, session);
    return clone(session);
  }

  async getAgentSession(sessionId: string): Promise<AgentSessionRecord | null> {
    const session = this.agentSessions.get(sessionId);
    return session ? clone(session) : null;
  }

  async endAgentSession(sessionId: string): Promise<void> {
    const session = this.agentSessions.get(sessionId);
    if (session && session.ended_at === undefined) session.ended_at = now();
  }

  async listAgentSessions(agentId: string): Promise<AgentSessionRecord[]> {
    return [...this.agentSessions.values()]
      .filter((s) => s.agent_id === agentId)
      .sort((a, b) => b.started_at - a.started_at)
      .map(clone);
  }

  async insertLogEntry(entry: NewLogEntry): Promise<LogEntry | null> {
    const key = `${entry.session_id}|${entry.seq}`;
    if (this.logKeys.has(key)) return null;
    this.logKeys.add(key);
    const stored: LogEntry = { ...clone(entry), cursor: ++this.cursor, received_at: now() };
    this.logs.push(stored);
    const session = this.agentSessions.get(entry.session_id);
    if (session) {
      session.log_count += 1;
      session.last_log_at = stored.received_at;
    }
    return clone(stored);
  }

  async logsBySession(sessionId: string, opts?: { publicOnly?: boolean; afterSeq?: number }): Promise<LogEntry[]> {
    return this.logs
      .filter(
        (l) =>
          l.session_id === sessionId &&
          (!opts?.publicOnly || l.visibility === "public") &&
          (opts?.afterSeq === undefined || l.seq > opts.afterSeq),
      )
      .sort((a, b) => a.seq - b.seq)
      .map(clone);
  }

  async publicLogs(filter: LogFilter): Promise<LogEntry[]> {
    return this.filteredLogs(filter, (l) => l.visibility === "public");
  }

  async masterLogs(masterIdValue: string, filter: LogFilter): Promise<LogEntry[]> {
    const owned = new Set([...this.agents.values()].filter((a) => a.master_id === masterIdValue).map((a) => a.id));
    return this.filteredLogs(filter, (l) => owned.has(l.agent_id));
  }

  private filteredLogs(filter: LogFilter, extra: (l: LogEntry) => boolean): LogEntry[] {
    const limit = boundedLimit(filter.limit);
    return this.logs
      .filter(
        (l) =>
          extra(l) &&
          (filter.sessionId === undefined || l.session_id === filter.sessionId) &&
          (filter.agentId === undefined || l.agent_id === filter.agentId) &&
          (filter.afterCursor === undefined || l.cursor > filter.afterCursor),
      )
      .sort((a, b) => a.cursor - b.cursor)
      .slice(0, limit)
      .map(clone);
  }
}

// ---------------------------------------------------------------------------
// SQLite twin
// ---------------------------------------------------------------------------

function sqlitePath(databaseUrl: string): string {
  if (databaseUrl === ":memory:" || databaseUrl === "sqlite::memory:" || databaseUrl === "sqlite://:memory:") {
    return ":memory:";
  }
  if (databaseUrl.startsWith("sqlite://")) return databaseUrl.slice("sqlite://".length);
  if (databaseUrl.startsWith("sqlite:")) return databaseUrl.slice("sqlite:".length);
  return databaseUrl;
}

function parseJson<T>(row: { json: string } | undefined): T | undefined {
  return row ? (JSON.parse(row.json) as T) : undefined;
}

export class SqliteAgentStore implements AgentStore {
  private readonly db: DatabaseSync;

  constructor(databaseUrl = "sqlite://./mosaic-agent-backend.db") {
    const path = sqlitePath(databaseUrl);
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, subject TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, json TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS masters (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_identities (
        id TEXT PRIMARY KEY,
        master_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        stellar_public_key TEXT NOT NULL,
        eth_address TEXT NOT NULL,
        json TEXT NOT NULL,
        UNIQUE(master_id, idx),
        UNIQUE(stellar_public_key),
        UNIQUE(eth_address)
      );
      CREATE TABLE IF NOT EXISTS runners (id TEXT PRIMARY KEY, master_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sealed_keys (agent_id TEXT NOT NULL, runner_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(agent_id, runner_id));
      CREATE TABLE IF NOT EXISTS agent_data (
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY(agent_id, kind, key)
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, started_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS log_entries (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        visibility TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_agents_master ON agent_identities(master_id, idx);
      CREATE INDEX IF NOT EXISTS idx_runners_master ON runners(master_id);
      CREATE INDEX IF NOT EXISTS idx_data_agent ON agent_data(agent_id, kind);
      CREATE INDEX IF NOT EXISTS idx_sessions_agent ON agent_sessions(agent_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_session_seq ON log_entries(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_logs_agent ON log_entries(agent_id, cursor);
      CREATE INDEX IF NOT EXISTS idx_logs_visibility ON log_entries(visibility, cursor);
    `);
  }

  async createChallenge(subject: string, message: string): Promise<StoredChallenge> {
    const challenge: StoredChallenge = { id: randomUUID(), subject, message, expires_at: now() + CHALLENGE_TTL_MS };
    this.db
      .prepare("INSERT INTO challenges(id, subject, message, expires_at) VALUES(?, ?, ?, ?)")
      .run(challenge.id, challenge.subject, challenge.message, challenge.expires_at);
    return challenge;
  }

  async consumeChallenge(id: string, subject: string): Promise<StoredChallenge> {
    const challenge = this.db.prepare("SELECT id, subject, message, expires_at FROM challenges WHERE id = ?").get(id) as
      | StoredChallenge
      | undefined;
    if (!challenge || challenge.subject !== subject || challenge.expires_at < now()) {
      throw err(401, "unknown or expired challenge");
    }
    this.db.prepare("DELETE FROM challenges WHERE id = ?").run(id);
    return challenge;
  }

  async createSession(payload: SessionPayload): Promise<{ token: string; session: StoredSession }> {
    const token = randomBytes(32).toString("hex");
    const session: StoredSession = { ...payload, expires_at: now() + SESSION_TTL_MS };
    this.db
      .prepare("INSERT INTO sessions(token_hash, json, expires_at) VALUES(?, ?, ?)")
      .run(tokenHash(token), JSON.stringify(session), session.expires_at);
    return { token, session };
  }

  async getSession(token: string): Promise<StoredSession | null> {
    const session = parseJson<StoredSession>(
      this.db.prepare("SELECT json FROM sessions WHERE token_hash = ?").get(tokenHash(token)) as { json: string } | undefined,
    );
    if (!session || session.expires_at < now()) return null;
    return session;
  }

  async deleteSession(token: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
  }

  async upsertMaster(chain: "stellar" | "ethereum", address: string): Promise<MasterRecord> {
    const id = masterId(chain, address);
    const existing = parseJson<MasterRecord>(
      this.db.prepare("SELECT json FROM masters WHERE id = ?").get(id) as { json: string } | undefined,
    );
    if (existing) return existing;
    const record: MasterRecord = { id, chain, address: chain === "ethereum" ? address.toLowerCase() : address, created_at: now() };
    this.db.prepare("INSERT INTO masters(id, json) VALUES(?, ?)").run(id, JSON.stringify(record));
    return record;
  }

  async registerAgent(masterIdValue: string, descriptor: AgentIdentityDescriptor): Promise<AgentRecord> {
    validateDescriptor(descriptor);
    const byIndex = parseJson<AgentRecord>(
      this.db
        .prepare("SELECT json FROM agent_identities WHERE master_id = ? AND idx = ?")
        .get(masterIdValue, descriptor.index) as { json: string } | undefined,
    );
    const existing = reconcileRegistration(
      descriptor,
      byIndex,
      await this.agentByStellarKey(descriptor.stellar_public_key),
      await this.agentByEthAddress(descriptor.eth_address),
    );
    if (existing) return existing;
    const record = newAgentRecord(masterIdValue, descriptor);
    this.db
      .prepare(
        "INSERT INTO agent_identities(id, master_id, idx, stellar_public_key, eth_address, json) VALUES(?, ?, ?, ?, ?, ?)",
      )
      .run(record.id, record.master_id, record.index, record.stellar_public_key, record.eth_address, JSON.stringify(record));
    return record;
  }

  async listAgents(masterIdValue: string): Promise<AgentRecord[]> {
    return (
      this.db.prepare("SELECT json FROM agent_identities WHERE master_id = ? ORDER BY idx").all(masterIdValue) as { json: string }[]
    ).map((row) => JSON.parse(row.json) as AgentRecord);
  }

  async getAgent(agentId: string): Promise<AgentRecord> {
    const agent = parseJson<AgentRecord>(
      this.db.prepare("SELECT json FROM agent_identities WHERE id = ?").get(agentId) as { json: string } | undefined,
    );
    if (!agent) throw err(404, `agent ${agentId} not found`);
    return agent;
  }

  async agentByStellarKey(stellarPublicKey: string): Promise<AgentRecord | null> {
    return (
      parseJson<AgentRecord>(
        this.db.prepare("SELECT json FROM agent_identities WHERE stellar_public_key = ?").get(stellarPublicKey) as
          | { json: string }
          | undefined,
      ) ?? null
    );
  }

  async agentByEthAddress(ethAddress: string): Promise<AgentRecord | null> {
    return (
      parseJson<AgentRecord>(
        this.db.prepare("SELECT json FROM agent_identities WHERE eth_address = ?").get(ethAddress.toLowerCase()) as
          | { json: string }
          | undefined,
      ) ?? null
    );
  }

  async revokeAgent(masterIdValue: string, agentId: string): Promise<AgentRecord> {
    const agent = await this.ownedAgent(masterIdValue, agentId);
    agent.revoked = true;
    agent.desired_state = "stopped";
    this.saveAgent(agent);
    return agent;
  }

  async setDesiredState(masterIdValue: string, agentId: string, state: "running" | "stopped"): Promise<AgentRecord> {
    const agent = await this.ownedAgent(masterIdValue, agentId);
    if (agent.revoked && state === "running") throw err(409, "agent is revoked");
    agent.desired_state = state;
    this.saveAgent(agent);
    return agent;
  }

  private saveAgent(agent: AgentRecord): void {
    this.db.prepare("UPDATE agent_identities SET json = ? WHERE id = ?").run(JSON.stringify(agent), agent.id);
  }

  private async ownedAgent(masterIdValue: string, agentId: string): Promise<AgentRecord> {
    const agent = await this.getAgent(agentId).catch(() => null);
    if (!agent || agent.master_id !== masterIdValue) throw err(404, `agent ${agentId} not found`);
    return agent;
  }

  async registerRunner(
    masterIdValue: string,
    keys: { auth_public_key: string; seal_public_key: string; name?: string; runtime_version?: string },
  ): Promise<RunnerRecord> {
    const record: RunnerRecord = {
      id: randomUUID(),
      master_id: masterIdValue,
      ...(keys.name !== undefined ? { name: keys.name } : {}),
      auth_public_key: keys.auth_public_key,
      seal_public_key: keys.seal_public_key,
      runtime_version: keys.runtime_version ?? "latest",
      revoked: false,
      created_at: now(),
    };
    this.db.prepare("INSERT INTO runners(id, master_id, json) VALUES(?, ?, ?)").run(record.id, record.master_id, JSON.stringify(record));
    return record;
  }

  async listRunners(masterIdValue: string): Promise<RunnerRecord[]> {
    return (this.db.prepare("SELECT json FROM runners WHERE master_id = ? ORDER BY rowid").all(masterIdValue) as { json: string }[]).map(
      (row) => JSON.parse(row.json) as RunnerRecord,
    );
  }

  async getRunner(runnerId: string): Promise<RunnerRecord> {
    const runner = parseJson<RunnerRecord>(
      this.db.prepare("SELECT json FROM runners WHERE id = ?").get(runnerId) as { json: string } | undefined,
    );
    if (!runner) throw err(404, `runner ${runnerId} not found`);
    return runner;
  }

  async updateRunner(
    masterIdValue: string,
    runnerId: string,
    patch: { name?: string; runtime_version?: string },
  ): Promise<RunnerRecord> {
    const runner = await this.ownedRunner(masterIdValue, runnerId);
    if (patch.name !== undefined) runner.name = patch.name;
    if (patch.runtime_version !== undefined) runner.runtime_version = patch.runtime_version;
    this.saveRunner(runner);
    return runner;
  }

  async revokeRunner(masterIdValue: string, runnerId: string): Promise<RunnerRecord> {
    const runner = await this.ownedRunner(masterIdValue, runnerId);
    runner.revoked = true;
    this.saveRunner(runner);
    return runner;
  }

  async heartbeatRunner(runnerId: string, instanceId: string): Promise<{ conflict: boolean }> {
    const runner = await this.getRunner(runnerId).catch(() => null);
    if (!runner || runner.revoked) throw err(404, `runner ${runnerId} not found`);
    if (runner.instance_id && runner.instance_id !== instanceId && (runner.last_seen ?? 0) > now() - HEARTBEAT_CONFLICT_MS) {
      return { conflict: true };
    }
    runner.instance_id = instanceId;
    runner.last_seen = now();
    this.saveRunner(runner);
    return { conflict: false };
  }

  private saveRunner(runner: RunnerRecord): void {
    this.db.prepare("UPDATE runners SET json = ? WHERE id = ?").run(JSON.stringify(runner), runner.id);
  }

  private async ownedRunner(masterIdValue: string, runnerId: string): Promise<RunnerRecord> {
    const runner = await this.getRunner(runnerId).catch(() => null);
    if (!runner || runner.master_id !== masterIdValue) throw err(404, `runner ${runnerId} not found`);
    return runner;
  }

  async putSealedRoot(masterIdValue: string, agentId: string, runnerId: string, envelope: SealedRootEnvelope): Promise<void> {
    await this.ownedAgent(masterIdValue, agentId);
    await this.ownedRunner(masterIdValue, runnerId);
    this.db
      .prepare(
        "INSERT INTO sealed_keys(agent_id, runner_id, json) VALUES(?, ?, ?) ON CONFLICT(agent_id, runner_id) DO UPDATE SET json = excluded.json",
      )
      .run(agentId, runnerId, JSON.stringify(envelope));
  }

  async sealedRoot(agentId: string, runnerId: string): Promise<SealedRootEnvelope | null> {
    return (
      parseJson<SealedRootEnvelope>(
        this.db.prepare("SELECT json FROM sealed_keys WHERE agent_id = ? AND runner_id = ?").get(agentId, runnerId) as
          | { json: string }
          | undefined,
      ) ?? null
    );
  }

  async putAgentData(agentId: string, kind: AgentDataKind, key: string, value: unknown, updatedBy: string): Promise<void> {
    const stored: AgentDataValue = { value, updated_at: now(), updated_by: updatedBy };
    this.db
      .prepare(
        "INSERT INTO agent_data(agent_id, kind, key, json) VALUES(?, ?, ?, ?) ON CONFLICT(agent_id, kind, key) DO UPDATE SET json = excluded.json",
      )
      .run(agentId, kind, key, JSON.stringify(stored));
  }

  async deleteAgentData(agentId: string, kind: AgentDataKind, key: string): Promise<void> {
    this.db.prepare("DELETE FROM agent_data WHERE agent_id = ? AND kind = ? AND key = ?").run(agentId, kind, key);
  }

  async agentData(agentId: string, kind: AgentDataKind): Promise<Record<string, AgentDataValue>> {
    const rows = this.db.prepare("SELECT key, json FROM agent_data WHERE agent_id = ? AND kind = ?").all(agentId, kind) as {
      key: string;
      json: string;
    }[];
    const out: Record<string, AgentDataValue> = {};
    for (const row of rows) out[row.key] = JSON.parse(row.json) as AgentDataValue;
    return out;
  }

  async createAgentSession(agentId: string): Promise<AgentSessionRecord> {
    const session: AgentSessionRecord = { id: randomUUID(), agent_id: agentId, started_at: now(), log_count: 0 };
    this.db
      .prepare("INSERT INTO agent_sessions(id, agent_id, started_at, json) VALUES(?, ?, ?, ?)")
      .run(session.id, session.agent_id, session.started_at, JSON.stringify(session));
    return session;
  }

  async getAgentSession(sessionId: string): Promise<AgentSessionRecord | null> {
    return (
      parseJson<AgentSessionRecord>(
        this.db.prepare("SELECT json FROM agent_sessions WHERE id = ?").get(sessionId) as { json: string } | undefined,
      ) ?? null
    );
  }

  async endAgentSession(sessionId: string): Promise<void> {
    const session = await this.getAgentSession(sessionId);
    if (session && session.ended_at === undefined) {
      session.ended_at = now();
      this.saveAgentSession(session);
    }
  }

  async listAgentSessions(agentId: string): Promise<AgentSessionRecord[]> {
    return (
      this.db.prepare("SELECT json FROM agent_sessions WHERE agent_id = ? ORDER BY started_at DESC").all(agentId) as { json: string }[]
    ).map((row) => JSON.parse(row.json) as AgentSessionRecord);
  }

  private saveAgentSession(session: AgentSessionRecord): void {
    this.db.prepare("UPDATE agent_sessions SET json = ? WHERE id = ?").run(JSON.stringify(session), session.id);
  }

  async insertLogEntry(entry: NewLogEntry): Promise<LogEntry | null> {
    const received_at = now();
    const body = { ...entry, received_at };
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO log_entries(session_id, agent_id, seq, visibility, json, created_at) VALUES(?, ?, ?, ?, ?, ?)",
      )
      .run(entry.session_id, entry.agent_id, entry.seq, entry.visibility, JSON.stringify(body), received_at);
    if (result.changes === 0) return null;
    const stored: LogEntry = { ...body, cursor: Number(result.lastInsertRowid) };
    const session = await this.getAgentSession(entry.session_id);
    if (session) {
      session.log_count += 1;
      session.last_log_at = received_at;
      this.saveAgentSession(session);
    }
    return stored;
  }

  async logsBySession(sessionId: string, opts?: { publicOnly?: boolean; afterSeq?: number }): Promise<LogEntry[]> {
    const rows = this.db
      .prepare(
        `SELECT cursor, json FROM log_entries WHERE session_id = ?${opts?.publicOnly ? " AND visibility = 'public'" : ""}${
          opts?.afterSeq !== undefined ? " AND seq > ?" : ""
        } ORDER BY seq`,
      )
      .all(...([sessionId, ...(opts?.afterSeq !== undefined ? [opts.afterSeq] : [])] as (string | number)[])) as {
      cursor: number;
      json: string;
    }[];
    return rows.map(rowToLogEntry);
  }

  async publicLogs(filter: LogFilter): Promise<LogEntry[]> {
    return this.queryLogs("visibility = 'public'", [], filter);
  }

  async masterLogs(masterIdValue: string, filter: LogFilter): Promise<LogEntry[]> {
    return this.queryLogs("agent_id IN (SELECT id FROM agent_identities WHERE master_id = ?)", [masterIdValue], filter);
  }

  private queryLogs(baseWhere: string, baseParams: (string | number)[], filter: LogFilter): LogEntry[] {
    const where = [baseWhere];
    const params = [...baseParams];
    if (filter.sessionId !== undefined) {
      where.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.agentId !== undefined) {
      where.push("agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter.afterCursor !== undefined) {
      where.push("cursor > ?");
      params.push(filter.afterCursor);
    }
    const limit = boundedLimit(filter.limit);
    const rows = this.db
      .prepare(`SELECT cursor, json FROM log_entries WHERE ${where.join(" AND ")} ORDER BY cursor LIMIT ?`)
      .all(...params, limit) as { cursor: number; json: string }[];
    return rows.map(rowToLogEntry);
  }
}

function rowToLogEntry(row: { cursor: number; json: string }): LogEntry {
  return { ...(JSON.parse(row.json) as Omit<LogEntry, "cursor">), cursor: row.cursor };
}

export function openAgentStore(databaseUrl = "sqlite://./mosaic-agent-backend.db"): AgentStore {
  return new SqliteAgentStore(databaseUrl);
}
