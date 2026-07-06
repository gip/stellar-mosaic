// @mosaic/sdk/mcp-client — typed client to the Mosaic MCP server over Streamable HTTP, implementing
// the {@link McpClient} port. Used by the browser/CLI for the features that require a server (the
// Base→Stellar shield) and for authentication. Lazily connects on first use.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  AuthSession,
  BaseDeploymentConfig,
  BaseShieldConfig,
  BaseShieldDeposit,
  BaseShieldJob,
  BookSide,
  CatalogAsset,
  ClientAction,
  Desk,
  Operation,
  OperationEvent,
  OperationRequest,
  ProposeAssetBody,
  WalletBackupEnvelope,
  MosaicMcpErrorBody,
} from "./types.js";
import type { DeskCustody } from "./custody.js";
import type { ActivityEvent } from "./activity.js";
import type { ClientActionLease, McpClient, StellarSigner, SubmitResult } from "./ports.js";

export interface McpClientOptions {
  /** Base URL of the MCP server's Streamable-HTTP endpoint. */
  url: string;
  /** Client-side timeout for one MCP tool call. Default 60s; 0 disables. */
  callTimeoutMs?: number;
}

export class MosaicMcpClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly details?: unknown;
  readonly correlationId: string;

  constructor(tool: string, body: MosaicMcpErrorBody) {
    super(`MCP tool ${tool} failed [${body.code}]: ${body.message}`);
    this.name = "MosaicMcpClientError";
    this.code = body.code;
    this.retryable = body.retryable;
    this.status = body.status;
    this.details = body.details;
    this.correlationId = body.correlation_id;
  }
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

class HttpMcpClient implements McpClient {
  private readonly url: string;
  private readonly sessionStorageKey: string;
  private readonly callTimeoutMs: number;
  private client?: Client;
  private connecting?: Promise<Client>;
  private sessionToken?: string;
  private signer?: StellarSigner;
  private reauth?: Promise<void>;

  constructor(url: string, callTimeoutMs = 60_000) {
    this.url = url;
    this.callTimeoutMs = callTimeoutMs;
    this.sessionStorageKey = `mosaic.mcp.session.${url}`;
    this.sessionToken = this.readStoredSession();
  }

  private readStoredSession(): string | undefined {
    if (typeof localStorage === "undefined") return undefined;
    try {
      return localStorage.getItem(this.sessionStorageKey) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private writeStoredSession(token: string | undefined): void {
    if (typeof localStorage === "undefined") return;
    try {
      if (token) localStorage.setItem(this.sessionStorageKey, token);
      else localStorage.removeItem(this.sessionStorageKey);
    } catch {
      // The in-memory token still works for the current page if browser storage is unavailable.
    }
  }

  private endpoint(): URL {
    const raw = this.url.trim();
    if (/^https?:\/\//i.test(raw)) return new URL(raw);
    if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//i.test(raw)) return new URL(`http://${raw}`);
    const origin = typeof window !== "undefined" ? window.location.origin : undefined;
    if (origin) return new URL(raw, origin);
    throw new Error(`MCP URL must be absolute outside the browser: ${this.url}`);
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    // Memoize the in-flight handshake so a burst of concurrent calls (e.g. the flood of tool calls
    // fired the first time the UI switches into trusted mode) shares one connection instead of each
    // opening its own transport/session — orphaned sessions leave requests unanswered until they
    // fail with `-32001 Request timed out`.
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({ name: "@mosaic/sdk", version: "0.0.0" });
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

  private async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.callOnce<T>(name, args);
    } catch (error) {
      // A session-scoped call whose session expired mid-flight (e.g. a base-shield poll outliving the
      // server's session TTL) is transparently recovered: re-authenticate with the retained signer
      // and retry the call once with the fresh token. Non-authenticated calls (no `session` arg) and
      // the auth handshake itself (no signer retention loop) are unaffected.
      const recoverable = error instanceof MosaicMcpClientError && (error.code === "AUTH_EXPIRED" || error.code === "AUTH_INVALID");
      if (recoverable && this.signer && typeof args.session === "string") {
        await this.reauthenticate(this.signer);
        return this.callOnce<T>(name, { ...args, session: this.sessionToken });
      }
      throw error;
    }
  }

  /** Coalesce concurrent re-auth attempts (a burst of polls all seeing AUTH_EXPIRED) into one. */
  private reauthenticate(signer: StellarSigner): Promise<void> {
    if (!this.reauth) {
      this.reauth = this.authenticate(signer)
        .then(() => undefined)
        .finally(() => {
          this.reauth = undefined;
        });
    }
    return this.reauth;
  }

  private async callOnce<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const client = await this.connect();
    const call = client.callTool({ name, arguments: args });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const res = (await (this.callTimeoutMs > 0
      ? Promise.race([
          call.finally(() => {
            if (timer) clearTimeout(timer);
          }),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`MCP tool ${name} timed out after ${this.callTimeoutMs}ms`)), this.callTimeoutMs);
          }),
        ])
      : call)) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = res.content.find((c) => c.type === "text")?.text;
    // Branch on the MCP protocol-level `isError` flag — never on a top-level `error` key, since
    // successful domain payloads (Operation, BaseShieldJob) legitimately carry `error: string`.
    if (res.isError) {
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: MosaicMcpErrorBody };
          if (parsed.error) throw new MosaicMcpClientError(name, parsed.error);
        } catch (error) {
          if (error instanceof MosaicMcpClientError) throw error;
        }
      }
      throw new Error(`MCP tool ${name} failed: ${text ?? "no result"}`);
    }
    if (!text) throw new Error(`MCP tool ${name} failed: no result`);
    return JSON.parse(text) as T;
  }

  private requireToken(): string {
    if (!this.sessionToken) throw new Error("Call authenticate() before using authenticated MCP tools.");
    return this.sessionToken;
  }

  private auth(args: Record<string, unknown> = {}): Record<string, unknown> {
    return { session: this.requireToken(), ...args };
  }

  private leaseArgs(lease?: ClientActionLease): Record<string, unknown> {
    return lease ? { action_id: lease.action_id, lease_token: lease.lease_token } : {};
  }

  private submitResult(res: { ok?: boolean; result?: string; txHash?: string; status?: string }): SubmitResult {
    return { txHash: res.txHash ?? res.result ?? "", status: res.status ?? "SUCCESS" };
  }

  async authenticate(signer: StellarSigner): Promise<{ session: string }> {
    // Retain the signer so an expired session can be renewed transparently on the next call.
    this.signer = signer;
    const address = await signer.address();
    const ch = await this.call<{ challengeId: string; message: string }>("auth_challenge", { address });
    const signature = base64(await signer.signMessage(new TextEncoder().encode(ch.message)));
    const res = await this.call<{ token: string }>("auth_verify", {
      address,
      challengeId: ch.challengeId,
      signature,
    });
    this.sessionToken = res.token;
    this.writeStoredSession(res.token);
    return { session: res.token };
  }

  async session(): Promise<AuthSession | null> {
    if (!this.sessionToken) return null;
    return this.call<AuthSession | null>("auth_session", { session: this.sessionToken });
  }

  async logout(): Promise<void> {
    const token = this.sessionToken;
    this.sessionToken = undefined;
    this.signer = undefined;
    this.writeStoredSession(undefined);
    if (!token) return;
    await this.call("auth_logout", { session: token });
  }

  listDesks(): Promise<Desk[]> {
    return this.call("list_desks");
  }

  getDesk(id: string): Promise<Desk> {
    return this.call("get_desk", { id });
  }

  createDesk(body: {
    name: string;
    assets: { catalog_id: string; asset_id: number; symbol: string; token: string; decimals: number; kind: string }[];
    pairs: { base_asset: number; quote_asset: number }[];
    base_assets?: { asset_id: number; symbol: string; token: string }[];
    base_deployment?: { deployer_address: string; assets?: { asset_id: number; symbol: string; token: string }[] };
    /** Wait for Base L1 finality before minting shielded notes. Default false. */
    require_finality?: boolean;
  }): Promise<Desk> {
    return this.call("create_desk", this.auth({ body }));
  }

  baseDeploymentConfig(): Promise<BaseDeploymentConfig> {
    return this.call("base_deployment_config");
  }

  completeBaseDeployment(id: string, body: { tx_hash: string; bridge_address: string }): Promise<Desk> {
    return this.call("complete_base_deployment", this.auth({ id, body }));
  }

  retryBaseDeployment(id: string): Promise<Desk> {
    return this.call("retry_base_deployment", this.auth({ id }));
  }

  getBook(deskId: string, pair: number, side: number): Promise<BookSide> {
    return this.call("get_book", { desk_id: deskId, pair, side });
  }

  getDeskCustody(id: string): Promise<DeskCustody> {
    return this.call("get_desk_custody", { id });
  }

  listAssets(): Promise<CatalogAsset[]> {
    return this.call("list_assets", this.auth());
  }

  proposeAsset(body: ProposeAssetBody): Promise<CatalogAsset> {
    return this.call("propose_asset", this.auth({ body }));
  }

  trustAsset(id: string): Promise<{ ok: boolean }> {
    return this.call("trust_asset", this.auth({ id }));
  }

  untrustAsset(id: string): Promise<{ ok: boolean }> {
    return this.call("untrust_asset", this.auth({ id }));
  }

  createOperation(body: OperationRequest, idempotencyKey = crypto.randomUUID()): Promise<Operation> {
    return this.call("create_operation", this.auth({ body, idempotency_key: idempotencyKey }));
  }

  listOperations(): Promise<Operation[]> {
    return this.call("list_operations", this.auth());
  }

  getOperation(id: string): Promise<Operation> {
    return this.call("get_operation", this.auth({ id }));
  }

  cancelOperation(id: string): Promise<Operation> {
    return this.call("cancel_operation", this.auth({ id }));
  }

  claimClientAction(): Promise<{ action: ClientAction | null }> {
    return this.call("claim_client_action", this.auth());
  }

  heartbeatClientAction(id: string, leaseToken: string): Promise<{ lease_expires_at: number }> {
    return this.call("heartbeat_client_action", this.auth({ id, lease_token: leaseToken }));
  }

  completeClientAction(id: string, leaseToken: string, result: unknown): Promise<Operation> {
    return this.call("complete_client_action", this.auth({ id, lease_token: leaseToken, result }));
  }

  failClientAction(id: string, leaseToken: string, error: string, retryable = false): Promise<Operation> {
    return this.call("fail_client_action", this.auth({ id, lease_token: leaseToken, error, retryable }));
  }

  operationEventsSince(cursor: number): Promise<OperationEvent[]> {
    return this.call("operation_events_since", this.auth({ cursor }));
  }

  recordActivity(events: ActivityEvent[]): Promise<ActivityEvent[]> {
    return this.call("record_activity", this.auth({ events }));
  }

  activitySince(cursor: number): Promise<ActivityEvent[]> {
    return this.call("activity_since", this.auth({ cursor }));
  }

  async relayShield(deskId: string, txXdr: string, lease?: ClientActionLease): Promise<SubmitResult> {
    return this.submitResult(
      await this.call("relay_shield", this.auth({ desk_id: deskId, tx_xdr: txXdr, ...this.leaseArgs(lease) })),
    );
  }

  async relayOrder(
    deskId: string,
    proofB64: string,
    publicInputsB64: string,
    lease?: ClientActionLease,
  ): Promise<SubmitResult> {
    return this.submitResult(
      await this.call(
        "relay_order",
        this.auth({ desk_id: deskId, proof_b64: proofB64, public_inputs_b64: publicInputsB64, ...this.leaseArgs(lease) }),
      ),
    );
  }

  async relayJoin(
    deskId: string,
    proofB64: string,
    publicInputsB64: string,
    lease?: ClientActionLease,
  ): Promise<SubmitResult> {
    return this.submitResult(
      await this.call(
        "relay_join",
        this.auth({ desk_id: deskId, proof_b64: proofB64, public_inputs_b64: publicInputsB64, ...this.leaseArgs(lease) }),
      ),
    );
  }

  async relayUnshield(
    deskId: string,
    to: string,
    proofB64: string,
    publicInputsB64: string,
    lease?: ClientActionLease,
  ): Promise<SubmitResult> {
    return this.submitResult(
      await this.call(
        "relay_unshield",
        this.auth({ desk_id: deskId, to, proof_b64: proofB64, public_inputs_b64: publicInputsB64, ...this.leaseArgs(lease) }),
      ),
    );
  }

  async relayCancel(
    deskId: string,
    pairId: number,
    side: number,
    proofB64: string,
    publicInputsB64: string,
    lease?: ClientActionLease,
  ): Promise<SubmitResult> {
    return this.submitResult(
      await this.call(
        "relay_cancel",
        this.auth({
          desk_id: deskId,
          pair_id: pairId,
          side,
          proof_b64: proofB64,
          public_inputs_b64: publicInputsB64,
          ...this.leaseArgs(lease),
        }),
      ),
    );
  }

  getWalletBackup(backupId: string, readToken?: string): Promise<WalletBackupEnvelope | null> {
    return this.call("get_wallet_backup", { backup_id: backupId, ...(readToken ? { read_token: readToken } : this.sessionToken ? { session: this.sessionToken } : {}) });
  }

  putWalletBackup(
    backupId: string,
    body: WalletBackupEnvelope & { expected_generation: number; write_token: string },
  ): Promise<{ generation: number }> {
    // Send the session when authenticated so the server can bind the backup to this wallet as owner,
    // enabling session-based restore on a fresh device (no separately-stored read token needed).
    return this.call("put_wallet_backup", { backup_id: backupId, body, ...(this.sessionToken ? { session: this.sessionToken } : {}) });
  }

  baseShieldConfig(deskId: string): Promise<BaseShieldConfig> {
    return this.call("base_shield_config", { desk_id: deskId });
  }

  enqueueBaseShield(deskId: string, body: { expected_bridge: string; deposit_id: number; deposit?: BaseShieldDeposit }): Promise<BaseShieldJob> {
    return this.call("enqueue_base_shield", this.auth({ desk_id: deskId, body }));
  }

  listBaseShields(deskId: string): Promise<BaseShieldJob[]> {
    return this.call("list_base_shields", this.auth({ desk_id: deskId }));
  }

  retryBaseShield(jobId: string): Promise<BaseShieldJob> {
    return this.call("retry_base_shield", this.auth({ id: jobId }));
  }
}

/** Build an {@link McpClient} bound to a remote MCP server. */
export function createMcpClient(opts: McpClientOptions): McpClient {
  return new HttpMcpClient(opts.url, opts.callTimeoutMs);
}
