// Typed fetch client for the agent backend's REST API, covering all three scopes (master, runner,
// agent). Auth methods run the full challenge → sign → verify flow and keep the bearer internally.
// Browser-safe (plain fetch + the portable crypto modules).

import { sep53Digest } from "@mosaic/sdk";
import { Buffer } from "buffer";
import type { Keypair } from "@stellar/stellar-sdk";
import type { AgentIdentity } from "./derive.js";
import type { EthMessageSigner } from "./masters.js";
import { utf8 } from "./bytes.js";
import type {
  AgentConfig,
  AgentIdentityDescriptor,
  AgentRecord,
  AgentSessionRecord,
  LogEntry,
  RunnerRecord,
  RunnerState,
  SealedRootEnvelope,
} from "./types.js";

export interface BackendInfo {
  xmtp_address: `0x${string}` | null;
  xmtp_env: "dev" | "production" | "local";
  network_passphrase: string;
  derivation_version: number;
}

export interface LogQuery {
  session_id?: string;
  agent_id?: string;
  after_cursor?: number;
  limit?: number;
}

export interface AgentAuthResult {
  session_id: string;
  agent: AgentRecord;
  attached: Record<string, unknown>;
  expires_at: number;
}

export interface AgentDataSnapshot {
  attached: Record<string, { value: unknown; updated_at: number; updated_by: string }>;
  scratch: Record<string, { value: unknown; updated_at: number; updated_by: string }>;
}

/** The slice of the SDK's StellarSigner the master auth flow needs (satisfied by SecretKeySigner
 *  and by a thin Freighter adapter in the browser). signMessage must be SEP-0053. */
export interface StellarMessageSigner {
  address(): Promise<string>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

export class AgentBackendClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentBackendClientError";
  }
}

export class AgentBackendClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private token: string | undefined;

  constructor(baseUrl: string, opts?: { fetch?: typeof fetch; token?: string }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts?.fetch ?? fetch;
    this.token = opts?.token;
  }

  bearer(): string | undefined {
    return this.token;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new AgentBackendClientError(res.status, typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`);
    }
    return parsed as T;
  }

  private query(path: string, query: LogQuery): string {
    const params = new URLSearchParams();
    if (query.session_id) params.set("session_id", query.session_id);
    if (query.agent_id) params.set("agent_id", query.agent_id);
    if (query.after_cursor !== undefined) params.set("after_cursor", String(query.after_cursor));
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
  }

  // -- open ------------------------------------------------------------------

  info(): Promise<BackendInfo> {
    return this.call("GET", "/v1/info");
  }

  async publicLogs(query: LogQuery = {}): Promise<LogEntry[]> {
    const res = await this.call<{ entries: LogEntry[] }>("GET", this.query("/v1/logs/public", query));
    return res.entries;
  }

  // -- auth (challenge → sign → verify) ---------------------------------------

  async authenticateMasterStellar(signer: StellarMessageSigner): Promise<{ master_id: string }> {
    const address = await signer.address();
    const challenge = await this.call<{ challenge_id: string; message: string }>("POST", "/v1/auth/challenge", {
      chain: "stellar",
      address,
    });
    const signature = Buffer.from(await signer.signMessage(utf8(challenge.message))).toString("base64");
    const verified = await this.call<{ token: string; master_id: string }>("POST", "/v1/auth/verify", {
      chain: "stellar",
      address,
      challenge_id: challenge.challenge_id,
      signature,
    });
    this.token = verified.token;
    return { master_id: verified.master_id };
  }

  async authenticateMasterEth(signer: EthMessageSigner): Promise<{ master_id: string }> {
    const address = await signer.address();
    const challenge = await this.call<{ challenge_id: string; message: string }>("POST", "/v1/auth/challenge", {
      chain: "ethereum",
      address,
    });
    const signature = await signer.personalSign(challenge.message);
    const verified = await this.call<{ token: string; master_id: string }>("POST", "/v1/auth/verify", {
      chain: "ethereum",
      address,
      challenge_id: challenge.challenge_id,
      signature,
    });
    this.token = verified.token;
    return { master_id: verified.master_id };
  }

  async authenticateRunner(runnerId: string, authKeypair: Keypair): Promise<{ runner_id: string }> {
    const challenge = await this.call<{ challenge_id: string; message: string }>("POST", "/v1/runner/auth/challenge", {
      runner_id: runnerId,
    });
    const signature = authKeypair.sign(Buffer.from(sep53Digest(utf8(challenge.message)))).toString("base64");
    const verified = await this.call<{ token: string; runner_id: string }>("POST", "/v1/runner/auth/verify", {
      runner_id: runnerId,
      challenge_id: challenge.challenge_id,
      signature,
    });
    this.token = verified.token;
    return { runner_id: verified.runner_id };
  }

  async authenticateAgent(identity: AgentIdentity): Promise<AgentAuthResult> {
    const challenge = await this.call<{ challenge_id: string; message: string }>("POST", "/v1/agent/auth/challenge", {
      stellar_public_key: identity.stellarPublicKey,
    });
    const signature = identity.stellarKeypair.sign(Buffer.from(sep53Digest(utf8(challenge.message)))).toString("base64");
    const verified = await this.call<AgentAuthResult & { token: string }>("POST", "/v1/agent/auth/verify", {
      stellar_public_key: identity.stellarPublicKey,
      challenge_id: challenge.challenge_id,
      signature,
    });
    this.token = verified.token;
    const { token: _token, ...result } = verified;
    return result;
  }

  logout(): Promise<{ ok: boolean }> {
    const result = this.call<{ ok: boolean }>("POST", "/v1/auth/logout");
    this.token = undefined;
    return result;
  }

  // -- master scope ------------------------------------------------------------

  registerAgent(descriptor: AgentIdentityDescriptor): Promise<AgentRecord> {
    return this.call("POST", "/v1/agents", descriptor);
  }

  listAgents(): Promise<AgentRecord[]> {
    return this.call("GET", "/v1/agents");
  }

  getAgent(agentId: string): Promise<AgentRecord> {
    return this.call("GET", `/v1/agents/${agentId}`);
  }

  revokeAgent(agentId: string): Promise<AgentRecord> {
    return this.call("DELETE", `/v1/agents/${agentId}`);
  }

  setDesiredState(agentId: string, state: "running" | "stopped"): Promise<AgentRecord> {
    return this.call("PUT", `/v1/agents/${agentId}/desired-state`, { state });
  }

  putAttached(agentId: string, key: string, value: unknown): Promise<{ ok: boolean }> {
    return this.call("PUT", `/v1/agents/${agentId}/data/${encodeURIComponent(key)}`, { value });
  }

  deleteAttached(agentId: string, key: string): Promise<{ ok: boolean }> {
    return this.call("DELETE", `/v1/agents/${agentId}/data/${encodeURIComponent(key)}`);
  }

  putAgentConfig(agentId: string, config: AgentConfig): Promise<{ ok: boolean }> {
    return this.putAttached(agentId, "agent-config", config);
  }

  agentDataOf(agentId: string): Promise<AgentDataSnapshot> {
    return this.call("GET", `/v1/agents/${agentId}/data`);
  }

  agentSessions(agentId: string): Promise<AgentSessionRecord[]> {
    return this.call("GET", `/v1/agents/${agentId}/sessions`);
  }

  registerRunner(body: {
    auth_public_key: string;
    seal_public_key: string;
    name?: string;
    runtime_version?: string;
  }): Promise<RunnerRecord> {
    return this.call("POST", "/v1/runners", body);
  }

  listRunners(): Promise<RunnerRecord[]> {
    return this.call("GET", "/v1/runners");
  }

  updateRunner(runnerId: string, patch: { name?: string; runtime_version?: string }): Promise<RunnerRecord> {
    return this.call("PUT", `/v1/runners/${runnerId}`, patch);
  }

  revokeRunner(runnerId: string): Promise<RunnerRecord> {
    return this.call("DELETE", `/v1/runners/${runnerId}`);
  }

  putSealedRoot(agentId: string, runnerId: string, envelope: SealedRootEnvelope): Promise<{ ok: boolean }> {
    return this.call("PUT", `/v1/agents/${agentId}/sealed-keys/${runnerId}`, envelope);
  }

  async logs(query: LogQuery = {}): Promise<LogEntry[]> {
    const res = await this.call<{ entries: LogEntry[] }>("GET", this.query("/v1/logs", query));
    return res.entries;
  }

  async sessionLogs(sessionId: string): Promise<LogEntry[]> {
    const res = await this.call<{ entries: LogEntry[] }>("GET", `/v1/sessions/${sessionId}/logs`);
    return res.entries;
  }

  // -- runner scope --------------------------------------------------------------

  runnerState(): Promise<RunnerState> {
    return this.call("GET", "/v1/runner/state");
  }

  heartbeat(instanceId: string): Promise<{ ok: boolean; conflict?: boolean }> {
    return this.call("POST", "/v1/runner/heartbeat", { instance_id: instanceId });
  }

  // -- agent scope ----------------------------------------------------------------

  agentData(): Promise<AgentDataSnapshot> {
    return this.call("GET", "/v1/agent/data");
  }

  putScratch(key: string, value: unknown): Promise<{ ok: boolean }> {
    return this.call("PUT", `/v1/agent/scratch/${encodeURIComponent(key)}`, { value });
  }

  deleteScratch(key: string): Promise<{ ok: boolean }> {
    return this.call("DELETE", `/v1/agent/scratch/${encodeURIComponent(key)}`);
  }

  endSession(): Promise<{ ok: boolean }> {
    return this.call("POST", "/v1/agent/session/end");
  }
}
