// Typed MCP client for the agent backend, covering all three scopes (master, runner, agent). The
// method surface is unchanged from the REST era: auth methods run the full challenge → sign → verify
// flow (now over the paired *_auth_challenge / *_auth_verify tools) and keep the session token
// internally, injecting it as the `session` argument on every authenticated tool call. Failures are
// rebuilt into AgentBackendClientError with the original HTTP status carried in the server's typed
// error body — the runner daemon's 401 → re-authenticate logic depends on that surviving the
// transport change. Browser-safe (the frontend bundles this via @mosaic/agent-sdk/derive; it uses
// the same @modelcontextprotocol/sdk client entry points as @mosaic/sdk/mcp-client).
//
// The constructor takes the backend *origin* (http://host:port) — the same value encoded in runner
// MOSAIC_IDENTITY strings and VITE_AGENT_BACKEND_URL — and derives the /mcp endpoint and the plain-
// REST /v1/logs/public feed from it.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sep53Digest, type MosaicMcpErrorBody } from "@mosaic/sdk";
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

/** A transport-level failure that means our mcp-session-id is gone (backend restart, idle reaper) —
 *  distinct from a tool-level error result, which arrives as a successful response with isError. */
function staleTransport(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /initialize first|session (id )?not found|no valid session|HTTP 40[04]|not connected/i.test(message);
}

export class AgentBackendClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly callTimeoutMs: number;
  private client?: Client;
  private connecting?: Promise<Client>;
  private token: string | undefined;

  constructor(baseUrl: string, opts?: { fetch?: typeof fetch; token?: string; callTimeoutMs?: number }) {
    // Tolerate being handed the /mcp endpoint itself — the canonical input is the origin.
    this.origin = baseUrl.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
    this.fetchImpl = opts?.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.token = opts?.token;
    this.callTimeoutMs = opts?.callTimeoutMs ?? 60_000;
  }

  bearer(): string | undefined {
    return this.token;
  }

  private endpoint(): URL {
    const raw = `${this.origin}/mcp`;
    if (/^https?:\/\//i.test(raw)) return new URL(raw);
    if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//i.test(raw)) return new URL(`http://${raw}`);
    const origin = typeof window !== "undefined" ? window.location.origin : undefined;
    if (origin) return new URL(raw, origin);
    throw new Error(`agent backend URL must be absolute outside the browser: ${this.origin}`);
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    // Memoize the in-flight handshake so a burst of concurrent calls shares one transport/session
    // instead of each opening its own.
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({ name: "@mosaic/agent-sdk", version: "0.0.0" });
        await client.connect(new StreamableHTTPClientTransport(this.endpoint()));
        this.client = client;
        return client;
      })().catch((error) => {
        this.connecting = undefined;
        throw error;
      });
    }
    return this.connecting;
  }

  private resetTransport(): void {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    void client?.close().catch(() => {});
  }

  private async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.callOnce<T>(name, args);
    } catch (error) {
      // The long-lived daemon outlives the server's idle transport reaper and survives backend
      // restarts; both invalidate the mcp-session-id. Reconnect once and retry — a genuine tool
      // failure is an isError *result*, never a transport error, so this cannot double-apply a
      // failed operation that actually ran.
      if (error instanceof AgentBackendClientError || !staleTransport(error)) throw error;
      this.resetTransport();
      return this.callOnce<T>(name, args);
    }
  }

  private async callOnce<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const client = await this.connect();
    const call = client.callTool({ name, arguments: args });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const res = (await (this.callTimeoutMs > 0
      ? Promise.race([
          call.finally(() => {
            if (timer) clearTimeout(timer);
          }),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`agent backend tool ${name} timed out after ${this.callTimeoutMs}ms`)), this.callTimeoutMs);
          }),
        ])
      : call)) as { content: { type: string; text?: string }[]; isError?: boolean };
    const text = res.content.find((c) => c.type === "text")?.text;
    // Branch on the protocol-level isError flag — never on an error key in a success payload.
    if (res.isError) {
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: MosaicMcpErrorBody };
          if (parsed.error) throw new AgentBackendClientError(parsed.error.status, parsed.error.message);
        } catch (error) {
          if (error instanceof AgentBackendClientError) throw error;
        }
      }
      throw new Error(`agent backend tool ${name} failed: ${text ?? "no result"}`);
    }
    if (!text) throw new Error(`agent backend tool ${name} failed: no result`);
    return JSON.parse(text) as T;
  }

  /** The stored token, or "" so an unauthenticated call fails server-side with the same 401 the
   *  REST client got for a missing bearer. */
  private auth(args: Record<string, unknown> = {}): Record<string, unknown> {
    return { session: this.token ?? "", ...args };
  }

  private logArgs(query: LogQuery): Record<string, unknown> {
    return {
      ...(query.session_id !== undefined ? { session_id: query.session_id } : {}),
      ...(query.agent_id !== undefined ? { agent_id: query.agent_id } : {}),
      ...(query.after_cursor !== undefined ? { after_cursor: query.after_cursor } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    };
  }

  // -- open ------------------------------------------------------------------

  info(): Promise<BackendInfo> {
    return this.call("info");
  }

  /** Reads the plain-REST public feed (the same browser-linkable URL LogsPanel exposes). */
  async publicLogs(query: LogQuery = {}): Promise<LogEntry[]> {
    const params = new URLSearchParams();
    if (query.session_id) params.set("session_id", query.session_id);
    if (query.agent_id) params.set("agent_id", query.agent_id);
    if (query.after_cursor !== undefined) params.set("after_cursor", String(query.after_cursor));
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.toString();
    const res = await this.fetchImpl(`${this.origin}/v1/logs/public${qs ? `?${qs}` : ""}`);
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new AgentBackendClientError(res.status, typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`);
    }
    return (parsed as { entries: LogEntry[] }).entries;
  }

  // -- auth (challenge → sign → verify) ---------------------------------------

  async authenticateMasterStellar(signer: StellarMessageSigner): Promise<{ master_id: string }> {
    const address = await signer.address();
    const challenge = await this.call<{ challenge_id: string; message: string }>("master_auth_challenge", {
      chain: "stellar",
      address,
    });
    const signature = Buffer.from(await signer.signMessage(utf8(challenge.message))).toString("base64");
    const verified = await this.call<{ token: string; master_id: string }>("master_auth_verify", {
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
    const challenge = await this.call<{ challenge_id: string; message: string }>("master_auth_challenge", {
      chain: "ethereum",
      address,
    });
    const signature = await signer.personalSign(challenge.message);
    const verified = await this.call<{ token: string; master_id: string }>("master_auth_verify", {
      chain: "ethereum",
      address,
      challenge_id: challenge.challenge_id,
      signature,
    });
    this.token = verified.token;
    return { master_id: verified.master_id };
  }

  async authenticateRunner(runnerId: string, authKeypair: Keypair): Promise<{ runner_id: string }> {
    const challenge = await this.call<{ challenge_id: string; message: string }>("runner_auth_challenge", {
      runner_id: runnerId,
    });
    const signature = authKeypair.sign(Buffer.from(sep53Digest(utf8(challenge.message)))).toString("base64");
    const verified = await this.call<{ token: string; runner_id: string }>("runner_auth_verify", {
      runner_id: runnerId,
      challenge_id: challenge.challenge_id,
      signature,
    });
    this.token = verified.token;
    return { runner_id: verified.runner_id };
  }

  async authenticateAgent(identity: AgentIdentity): Promise<AgentAuthResult> {
    const challenge = await this.call<{ challenge_id: string; message: string }>("agent_auth_challenge", {
      stellar_public_key: identity.stellarPublicKey,
    });
    const signature = identity.stellarKeypair.sign(Buffer.from(sep53Digest(utf8(challenge.message)))).toString("base64");
    const verified = await this.call<AgentAuthResult & { token: string }>("agent_auth_verify", {
      stellar_public_key: identity.stellarPublicKey,
      challenge_id: challenge.challenge_id,
      signature,
    });
    this.token = verified.token;
    const { token: _token, ...result } = verified;
    return result;
  }

  logout(): Promise<{ ok: boolean }> {
    const result = this.call<{ ok: boolean }>("logout", this.auth());
    this.token = undefined;
    return result;
  }

  // -- master scope ------------------------------------------------------------

  registerAgent(descriptor: AgentIdentityDescriptor): Promise<AgentRecord> {
    return this.call("register_agent", this.auth({ descriptor }));
  }

  listAgents(): Promise<AgentRecord[]> {
    return this.call("list_agents", this.auth());
  }

  getAgent(agentId: string): Promise<AgentRecord> {
    return this.call("get_agent", this.auth({ agent_id: agentId }));
  }

  revokeAgent(agentId: string): Promise<AgentRecord> {
    return this.call("revoke_agent", this.auth({ agent_id: agentId }));
  }

  setDesiredState(agentId: string, state: "running" | "stopped"): Promise<AgentRecord> {
    return this.call("set_desired_state", this.auth({ agent_id: agentId, state }));
  }

  putAttached(agentId: string, key: string, value: unknown): Promise<{ ok: boolean }> {
    return this.call("put_attached_data", this.auth({ agent_id: agentId, key, value }));
  }

  deleteAttached(agentId: string, key: string): Promise<{ ok: boolean }> {
    return this.call("delete_attached_data", this.auth({ agent_id: agentId, key }));
  }

  putAgentConfig(agentId: string, config: AgentConfig): Promise<{ ok: boolean }> {
    return this.putAttached(agentId, "agent-config", config);
  }

  agentDataOf(agentId: string): Promise<AgentDataSnapshot> {
    return this.call("agent_data_of", this.auth({ agent_id: agentId }));
  }

  agentSessions(agentId: string): Promise<AgentSessionRecord[]> {
    return this.call("agent_sessions", this.auth({ agent_id: agentId }));
  }

  registerRunner(body: {
    auth_public_key: string;
    seal_public_key: string;
    name?: string;
    runtime_version?: string;
  }): Promise<RunnerRecord> {
    return this.call("register_runner", this.auth({ ...body }));
  }

  listRunners(): Promise<RunnerRecord[]> {
    return this.call("list_runners", this.auth());
  }

  updateRunner(runnerId: string, patch: { name?: string; runtime_version?: string }): Promise<RunnerRecord> {
    return this.call("update_runner", this.auth({ runner_id: runnerId, ...patch }));
  }

  revokeRunner(runnerId: string): Promise<RunnerRecord> {
    return this.call("revoke_runner", this.auth({ runner_id: runnerId }));
  }

  putSealedRoot(agentId: string, runnerId: string, envelope: SealedRootEnvelope): Promise<{ ok: boolean }> {
    return this.call("put_sealed_root", this.auth({ agent_id: agentId, runner_id: runnerId, envelope }));
  }

  async logs(query: LogQuery = {}): Promise<LogEntry[]> {
    const res = await this.call<{ entries: LogEntry[] }>("master_logs", this.auth(this.logArgs(query)));
    return res.entries;
  }

  async sessionLogs(sessionId: string): Promise<LogEntry[]> {
    const res = await this.call<{ entries: LogEntry[] }>("session_logs", this.auth({ session_id: sessionId }));
    return res.entries;
  }

  // -- runner scope --------------------------------------------------------------

  runnerState(): Promise<RunnerState> {
    return this.call("runner_state", this.auth());
  }

  heartbeat(instanceId: string): Promise<{ ok: boolean; conflict?: boolean }> {
    return this.call("runner_heartbeat", this.auth({ instance_id: instanceId }));
  }

  // -- agent scope ----------------------------------------------------------------

  agentData(): Promise<AgentDataSnapshot> {
    return this.call("agent_data", this.auth());
  }

  putScratch(key: string, value: unknown): Promise<{ ok: boolean }> {
    return this.call("put_scratch", this.auth({ key, value }));
  }

  deleteScratch(key: string): Promise<{ ok: boolean }> {
    return this.call("delete_scratch", this.auth({ key }));
  }

  endSession(): Promise<{ ok: boolean }> {
    return this.call("end_agent_session", this.auth());
  }

  /** Close the underlying MCP transport (long-lived processes should call this on shutdown). */
  async close(): Promise<void> {
    this.resetTransport();
  }
}
