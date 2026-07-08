import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readDeskCustody, type BaseShieldDeposit, type BookSide, type Desk, type DeskCustody, type MosaicLogger, type Operation, type SubmitResult } from "@mosaic/sdk";
import { Networks } from "@stellar/stellar-sdk";
import { z } from "zod";
import { AuthService, validateNetwork } from "./auth.js";
import { StellarBookReader } from "./book.js";
import type { BaseShieldConfig } from "./baseShield.js";
import { SponsoredStellarDeployHandlers } from "./deploy.js";
import { createStderrLogger } from "./logging.js";
import { envNumber } from "./env.js";
import { StellarCliRelayer } from "./relayer.js";
import { MemoryMosaicStore, type MosaicStore } from "./store.js";
import { MosaicMcpError, mcpErrorContent } from "./errors.js";

export interface RelayHandlers {
  relayShield(args: { desk_id: string; tx_xdr: string; operation?: Operation | null }): Promise<SubmitResult>;
  relayOrder(args: { desk_id: string; proof_b64: string; public_inputs_b64: string; operation?: Operation | null }): Promise<SubmitResult>;
  relayJoin(args: { desk_id: string; proof_b64: string; public_inputs_b64: string; operation?: Operation | null }): Promise<SubmitResult>;
  relayUnshield(args: { desk_id: string; to: string; proof_b64: string; public_inputs_b64: string; operation?: Operation | null }): Promise<SubmitResult>;
  relayCancel(args: {
    desk_id: string;
    pair_id: number;
    side: number;
    proof_b64: string;
    public_inputs_b64: string;
    operation?: Operation | null;
  }): Promise<SubmitResult>;
}

export interface DeployHandlers {
  createDesk(body: Record<string, unknown>, creator: string, network?: string): Promise<{ desk: Desk; sponsorSecret?: string | null }>;
  completeBaseDeployment(id: string, body: Record<string, unknown>, address: string): Promise<Desk>;
  retryBaseDeployment(id: string, address?: string, network?: string): Promise<Desk>;
  baseDeploymentConfig(): Promise<unknown>;
  /** Add members to a permissioned desk's on-chain allowlists (desk creator only; add-only). */
  addDeskAllowed?(
    id: string,
    body: { stellar_members?: string[]; evm_members?: string[] },
    address: string,
    network?: string,
  ): Promise<{ ok: boolean; stellar_tx_hashes: string[]; evm_tx_hashes: string[] }>;
}

export interface BookHandlers {
  getBook(args: { desk_id: string; pair: number; side: number }): Promise<BookSide>;
}

export interface CustodyHandlers {
  getCustody(args: { desk_id: string }): Promise<DeskCustody>;
}

export interface MosaicMcpOptions {
  auth?: AuthService;
  store?: MosaicStore;
  relays?: RelayHandlers;
  deploy?: DeployHandlers;
  books?: BookHandlers;
  custody?: CustodyHandlers;
  logger?: MosaicLogger;
  /** Remote prove-service config for the durable Base-shield worker; when set, the worker runs. */
  baseShield?: BaseShieldConfig;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

// A client (browser/CLI) aborts a slow tool call with JSON-RPC `-32001 Request timed out`, but that
// error is raised on the client — this server never sees it and, at the default `warn` log level,
// logs nothing for the still-running call (start is `debug`, completion is `info`). This threshold
// makes a long-running tool emit `warn` lines while it runs, so "what timed out" is visible in the
// server log at the moment the client gives up. Tune via MOSAIC_MCP_SLOW_TOOL_MS (0 disables).
const slowToolThresholdMs = (): number => envNumber("MOSAIC_MCP_SLOW_TOOL_MS", 15_000, { allowZero: true });

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
// A tool failure must set the MCP protocol-level `isError` flag, not just embed `{ok:false}` in the
// text — otherwise a generic MCP client (Claude Desktop, inspector, another agent) reads the failure
// as a successful result. The structured MosaicMcpErrorBody rides along in the text for clients that
// want the typed code/retryable/correlation_id.
const fail = (error: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify({ ok: false, ...mcpErrorContent(error) }) }], isError: true });
const body = (args: Record<string, unknown>) => (args.body ?? {}) as Record<string, unknown>;

const toolTimeoutMs = (): number => envNumber("MOSAIC_MCP_TOOL_TIMEOUT_MS", 120_000, { allowZero: true });

// Display metadata a browser attaches to a Base shield at enqueue time (amount + Base deposit tx), so
// the mint leg can render a full Activity entry without the local deposit event. Untrusted input:
// coerce each field and keep only the shapes we use; anything missing simply degrades gracefully.
function baseShieldDeposit(value: unknown): BaseShieldDeposit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const d = value as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  const deposit: BaseShieldDeposit = {
    asset_id: num(d.asset_id),
    symbol: str(d.symbol),
    decimals: num(d.decimals),
    amount: str(d.amount),
    base_tx_hash: str(d.base_tx_hash),
  };
  return Object.values(deposit).some((v) => v !== undefined) ? deposit : undefined;
}

async function session(auth: AuthService, args: Record<string, unknown>) {
  return auth.requireSession(String(args.session ?? ""));
}

async function requireLease(store: MosaicStore, auth: AuthService, args: Record<string, unknown>): Promise<Operation | null> {
  const actionId = args.action_id;
  const leaseToken = args.lease_token;
  if (typeof actionId !== "string" || typeof leaseToken !== "string") return null;
  const s = await session(auth, args);
  return (await store.validateActionLease(s.address, actionId, leaseToken)).operation;
}

function relayAllowed(operation: Operation, action: string): boolean {
  return (
    (operation.kind === "place_order" && (action === "relay_shield" || action === "relay_order" || action === "relay_join")) ||
    (operation.kind === "shield" && action === "relay_shield") ||
    (operation.kind === "unshield" && (action === "relay_join" || action === "relay_unshield")) ||
    (operation.kind === "cancel_order" && action === "relay_cancel")
  );
}

async function relayGuard(store: MosaicStore, auth: AuthService, args: Record<string, unknown>, expectedDesk: string, action: string) {
  const operation = await requireLease(store, auth, args);
  if (operation && operation.desk_id !== expectedDesk) throw new Error("client action does not authorize this desk");
  if (operation && !relayAllowed(operation, action)) throw new Error("client action does not authorize this relay");
  if (!operation) await session(auth, args);
  return operation;
}

export function createMosaicMcpServer(opts: MosaicMcpOptions = {}): McpServer {
  const store = opts.store ?? new MemoryMosaicStore();
  const auth = opts.auth ?? new AuthService(store);
  const relays = opts.relays ?? new StellarCliRelayer({ store });
  const deploy = opts.deploy ?? new SponsoredStellarDeployHandlers({ store });
  const books = opts.books ?? {
    getBook: async ({ desk_id, pair, side }) => new StellarBookReader().getBook(await store.getDesk(desk_id), pair, side),
  };
  const custody = opts.custody ?? {
    getCustody: async ({ desk_id }) =>
      readDeskCustody({
        desk: await store.getDesk(desk_id),
        stellar: {
          rpcUrl: process.env.MOSAIC_RPC ?? "https://soroban-testnet.stellar.org",
          networkPassphrase: process.env.MOSAIC_NETWORK_PASSPHRASE ?? Networks.TESTNET,
        },
        baseRpcUrl: process.env.MOSAIC_BASE_RPC,
        logger,
      }),
  };
  const logger = opts.logger ?? createStderrLogger();
  const slowMs = slowToolThresholdMs();
  const timeoutMs = toolTimeoutMs();
  const server = new McpServer({ name: "mosaic-mcp", version: "0.0.0" });

  const reg = (
    name: string,
    config: { description: string; inputSchema: z.ZodRawShape },
    handler: ToolHandler,
  ): void => {
    const wrapped: ToolHandler = async (args) => {
      const started = Date.now();
      logger.debug("mcp tool started", { tool: name });
      // Emit a `warn` line once the call crosses the slow threshold, then keep ticking, so a call
      // the client eventually abandons with `-32001 Request timed out` is named in this log while
      // it is still running (unref'd so it never keeps the process alive).
      const watchdog =
        slowMs > 0
          ? setInterval(() => {
              logger.warn("mcp tool still running", { tool: name, elapsed_ms: Date.now() - started });
            }, slowMs)
          : undefined;
      watchdog?.unref?.();
      try {
        const run = handler(args);
        const result =
          timeoutMs > 0
            ? await Promise.race([
                run,
                new Promise<ToolResult>((_resolve, reject) =>
                  setTimeout(() => reject(new MosaicMcpError("TIMEOUT", `MCP tool ${name} timed out after ${timeoutMs}ms`)), timeoutMs).unref?.(),
                ),
              ])
            : await run;
        logger.info("mcp tool completed", { tool: name, duration_ms: Date.now() - started });
        return result;
      } catch (error) {
        logger.error("mcp tool failed", { tool: name, duration_ms: Date.now() - started, error });
        return fail(error);
      } finally {
        if (watchdog) clearInterval(watchdog);
      }
    };
    (server.registerTool as unknown as (n: string, c: unknown, h: ToolHandler) => void)(name, config, wrapped);
  };

  reg(
    "auth_challenge",
    {
      description: "Begin wallet authentication: returns a message for the given Stellar address to sign.",
      inputSchema: { address: z.string().describe("Stellar public key (G...)"), network: z.string().optional(), audience: z.string().optional() },
    },
    async ({ address, network, audience }) => ok(await auth.challenge(String(address), { network: network ? String(network) : undefined, audience: audience ? String(audience) : undefined })),
  );

  reg(
    "auth_verify",
    {
      description: "Complete authentication: verify the signed challenge and return a session token.",
      inputSchema: { address: z.string(), challengeId: z.string(), signature: z.string() },
    },
    async ({ address, challengeId, signature }) =>
      ok(await auth.verify(String(address), String(challengeId), String(signature))),
  );

  reg(
    "auth_session",
    { description: "Return the current authenticated session.", inputSchema: { session: z.string() } },
    async (args) => {
      const s = await auth.getSession(String(args.session));
      return ok(s ? { address: s.address, network: s.network, expires_at: s.expiresAt } : null);
    },
  );

  reg(
    "auth_logout",
    { description: "Delete the current authenticated session.", inputSchema: { session: z.string() } },
    async (args) => {
      await auth.logout(String(args.session));
      return ok({ ok: true });
    },
  );

  reg("list_desks", { description: "List shared desks.", inputSchema: {} }, async () => ok(await store.listDesks()));
  reg("get_desk", { description: "Get one desk.", inputSchema: { id: z.string() } }, async ({ id }) =>
    ok(await store.getDesk(String(id))),
  );
  reg(
    "create_desk",
    { description: "Create and deploy a desk.", inputSchema: { session: z.string(), body: z.record(z.unknown()) } },
    async (args) => {
      const s = await session(auth, args);
      validateNetwork(s.network);
      const created = await deploy.createDesk(body(args), s.address, s.network);
      return ok(await store.insertDesk(created.desk, created.sponsorSecret ?? null));
    },
  );
  reg("base_deployment_config", { description: "Return Base deployment config.", inputSchema: {} }, async () =>
    ok(await deploy.baseDeploymentConfig()),
  );
  reg(
    "complete_base_deployment",
    { description: "Complete Base bridge deployment.", inputSchema: { session: z.string(), id: z.string(), body: z.record(z.unknown()) } },
    async (args) => {
      const s = await session(auth, args);
      validateNetwork(s.network);
      return ok(await deploy.completeBaseDeployment(String(args.id), body(args), s.address));
    },
  );
  reg(
    "retry_base_deployment",
    { description: "Re-run the server-side Base bridge deploy for a desk whose bridge is not yet active.", inputSchema: { session: z.string(), id: z.string() } },
    async (args) => {
      const s = await session(auth, args);
      validateNetwork(s.network);
      return ok(await deploy.retryBaseDeployment(String(args.id), s.address, s.network));
    },
  );
  reg(
    "add_desk_allowed",
    {
      description:
        "Add members to a permissioned desk's allowlists (desk creator only; add-only — there is no removal). " +
        "`stellar_members` are G… addresses added on the settlement contract; `evm_members` are 0x… addresses added on the Base bridge.",
      inputSchema: {
        session: z.string(),
        desk_id: z.string(),
        stellar_members: z.array(z.string()).optional(),
        evm_members: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      if (!deploy.addDeskAllowed) throw new Error("allowlist management is not configured on this MCP server");
      const s = await session(auth, args);
      validateNetwork(s.network);
      return ok(
        await deploy.addDeskAllowed(
          String(args.desk_id),
          {
            stellar_members: args.stellar_members as string[] | undefined,
            evm_members: args.evm_members as string[] | undefined,
          },
          s.address,
          s.network,
        ),
      );
    },
  );

  reg(
    "get_book",
    {
      description: "Read one public on-chain book side for a desk.",
      inputSchema: { desk_id: z.string(), pair: z.number(), side: z.number() },
    },
    async (args) => ok(await books.getBook({ desk_id: String(args.desk_id), pair: Number(args.pair), side: Number(args.side) })),
  );

  reg(
    "get_desk_custody",
    {
      description: "Read a desk's total committed amounts per asset, on Stellar and Base.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => ok(await custody.getCustody({ desk_id: String(id) })),
  );

  reg("list_assets", { description: "List catalog assets.", inputSchema: { session: z.string() } }, async (args) => {
    const s = await session(auth, args);
    return ok(await store.listAssets(s.address));
  });
  reg(
    "propose_asset",
    { description: "Propose a catalog asset.", inputSchema: { session: z.string(), body: z.record(z.unknown()) } },
    async (args) => ok(await store.proposeAsset(body(args), (await session(auth, args)).address)),
  );
  reg("trust_asset", { description: "Trust a catalog asset.", inputSchema: { session: z.string(), id: z.string() } }, async (args) =>
    ok(await store.setTrust(String(args.id), (await session(auth, args)).address, true)),
  );
  reg("untrust_asset", { description: "Untrust a catalog asset.", inputSchema: { session: z.string(), id: z.string() } }, async (args) =>
    ok(await store.setTrust(String(args.id), (await session(auth, args)).address, false)),
  );

  reg(
    "create_operation",
    { description: "Create a durable wallet operation.", inputSchema: { session: z.string(), body: z.record(z.unknown()), idempotency_key: z.string() } },
    async (args) => {
      const s = await session(auth, args);
      validateNetwork(s.network);
      return ok(await store.createOperation(s.address, s.network, body(args) as never, String(args.idempotency_key)));
    },
  );
  reg("list_operations", { description: "List operations.", inputSchema: { session: z.string() } }, async (args) =>
    ok(await store.listOperations((await session(auth, args)).address)),
  );
  reg("get_operation", { description: "Get operation.", inputSchema: { session: z.string(), id: z.string() } }, async (args) =>
    ok(await store.getOperation((await session(auth, args)).address, String(args.id))),
  );
  reg("cancel_operation", { description: "Cancel operation.", inputSchema: { session: z.string(), id: z.string() } }, async (args) =>
    ok(await store.cancelOperation((await session(auth, args)).address, String(args.id))),
  );
  reg("claim_client_action", { description: "Claim next client action.", inputSchema: { session: z.string() } }, async (args) =>
    ok({ action: await store.claimAction((await session(auth, args)).address) }),
  );
  reg(
    "heartbeat_client_action",
    { description: "Heartbeat a leased client action.", inputSchema: { session: z.string(), id: z.string(), lease_token: z.string() } },
    async (args) => ok(await store.heartbeatAction((await session(auth, args)).address, String(args.id), String(args.lease_token))),
  );
  reg(
    "complete_client_action",
    { description: "Complete a leased client action.", inputSchema: { session: z.string(), id: z.string(), lease_token: z.string(), result: z.unknown() } },
    async (args) =>
      ok(await store.completeAction((await session(auth, args)).address, String(args.id), String(args.lease_token), args.result)),
  );
  reg(
    "fail_client_action",
    {
      description: "Fail a leased client action.",
      inputSchema: { session: z.string(), id: z.string(), lease_token: z.string(), error: z.string(), retryable: z.boolean().optional() },
    },
    async (args) => {
      const s = await session(auth, args);
      // The generic tool wrapper only logs name/duration on success, so a client-reported failure
      // (proving/relay error the browser hit) would otherwise never appear in this process's own
      // logs — only in the stored operation, which nothing here surfaces. Log it explicitly.
      logger.warn("client action failed", {
        address: s.address,
        action_id: String(args.id),
        error: String(args.error),
        retryable: Boolean(args.retryable),
      });
      return ok(
        await store.failAction(s.address, String(args.id), String(args.lease_token), String(args.error), Boolean(args.retryable)),
      );
    },
  );
  reg("operation_events_since", { description: "Replay operation events.", inputSchema: { session: z.string(), cursor: z.number() } }, async (args) =>
    ok(await store.eventsAfter((await session(auth, args)).address, Number(args.cursor))),
  );
  reg(
    "record_activity",
    { description: "Persist client-generated activity events.", inputSchema: { session: z.string(), events: z.array(z.record(z.unknown())) } },
    async (args) => {
      const s = await session(auth, args);
      return ok(await store.recordActivity(s.address, s.network, args.events as never));
    },
  );
  reg("activity_since", { description: "Replay persisted activity events.", inputSchema: { session: z.string(), cursor: z.number() } }, async (args) => {
    const s = await session(auth, args);
    return ok(await store.activityAfter(s.address, s.network, Number(args.cursor)));
  });

  reg("relay_shield", { description: "Relay sponsored shield.", inputSchema: { session: z.string(), desk_id: z.string(), tx_xdr: z.string(), action_id: z.string().optional(), lease_token: z.string().optional() } }, async (args) => {
    const operation = await relayGuard(store, auth, args, String(args.desk_id), "relay_shield");
    return ok(await relays.relayShield({ desk_id: String(args.desk_id), tx_xdr: String(args.tx_xdr), operation }));
  });
  reg("relay_order", { description: "Relay order proof.", inputSchema: { session: z.string(), desk_id: z.string(), proof_b64: z.string(), public_inputs_b64: z.string(), action_id: z.string().optional(), lease_token: z.string().optional() } }, async (args) => {
    const operation = await relayGuard(store, auth, args, String(args.desk_id), "relay_order");
    return ok(await relays.relayOrder({ desk_id: String(args.desk_id), proof_b64: String(args.proof_b64), public_inputs_b64: String(args.public_inputs_b64), operation }));
  });
  reg("relay_join", { description: "Relay join proof.", inputSchema: { session: z.string(), desk_id: z.string(), proof_b64: z.string(), public_inputs_b64: z.string(), action_id: z.string().optional(), lease_token: z.string().optional() } }, async (args) => {
    const operation = await relayGuard(store, auth, args, String(args.desk_id), "relay_join");
    return ok(await relays.relayJoin({ desk_id: String(args.desk_id), proof_b64: String(args.proof_b64), public_inputs_b64: String(args.public_inputs_b64), operation }));
  });
  reg("relay_unshield", { description: "Relay unshield proof.", inputSchema: { session: z.string(), desk_id: z.string(), to: z.string(), proof_b64: z.string(), public_inputs_b64: z.string(), action_id: z.string().optional(), lease_token: z.string().optional() } }, async (args) => {
    const operation = await relayGuard(store, auth, args, String(args.desk_id), "relay_unshield");
    return ok(await relays.relayUnshield({ desk_id: String(args.desk_id), to: String(args.to), proof_b64: String(args.proof_b64), public_inputs_b64: String(args.public_inputs_b64), operation }));
  });
  reg("relay_cancel", { description: "Relay cancel proof.", inputSchema: { session: z.string(), desk_id: z.string(), pair_id: z.number(), side: z.number(), proof_b64: z.string(), public_inputs_b64: z.string(), action_id: z.string().optional(), lease_token: z.string().optional() } }, async (args) => {
    const operation = await relayGuard(store, auth, args, String(args.desk_id), "relay_cancel");
    return ok(await relays.relayCancel({ desk_id: String(args.desk_id), pair_id: Number(args.pair_id), side: Number(args.side), proof_b64: String(args.proof_b64), public_inputs_b64: String(args.public_inputs_b64), operation }));
  });

  reg("get_wallet_backup", { description: "Read opaque wallet backup.", inputSchema: { backup_id: z.string(), read_token: z.string().optional(), session: z.string().optional() } }, async (args) => {
    const s = typeof args.session === "string" && args.session ? await auth.getSession(args.session) : null;
    return ok(await store.getWalletBackupForRead(String(args.backup_id), typeof args.read_token === "string" ? args.read_token : undefined, s?.address));
  },
  );
  reg(
    "put_wallet_backup",
    { description: "Write opaque wallet backup.", inputSchema: { backup_id: z.string(), session: z.string().optional(), body: z.record(z.unknown()) } },
    async (args) => {
      const b = body(args);
      // Bind the backup to the authenticated owner when a session is supplied, so it can later be
      // read back by that wallet on a fresh device without a separately-stored read token.
      const owner = typeof args.session === "string" && args.session ? (await auth.getSession(args.session))?.address : undefined;
      return ok(
        await store.putWalletBackup(
          String(args.backup_id),
          String(b.write_token),
          typeof b.read_token === "string" ? b.read_token : undefined,
          Number(b.expected_generation),
          {
            format_version: 1,
            generation: Number(b.generation ?? 0),
            nonce_b64: String(b.nonce_b64),
            ciphertext_b64: String(b.ciphertext_b64),
          },
          owner,
        ),
      );
    },
  );

  reg("base_shield_config", { description: "Base shield readiness for a desk.", inputSchema: { desk_id: z.string() } }, async ({ desk_id }) => {
    const desk = await store.getDesk(String(desk_id));
    const bridge = desk.base_deployment?.bridge_address ?? null;
    const workerReady = !!opts.baseShield;
    const reason = bridge ? (workerReady ? null : "worker_disabled") : "contract_unconfigured";
    return ok({ available: reason === null, chain_id: 84532, network: "base-sepolia", bridge, worker_ready: workerReady, reason });
  });
  reg(
    "enqueue_base_shield",
    { description: "Enqueue a durable Base shield job.", inputSchema: { session: z.string(), desk_id: z.string(), body: z.record(z.unknown()) } },
    async (args) => {
      const s = await session(auth, args);
      const b = body(args);
      return ok(await store.enqueueBaseShield(String(args.desk_id), String(b.expected_bridge), Number(b.deposit_id), s.address, baseShieldDeposit(b.deposit)));
    },
  );
  reg("list_base_shields", { description: "List Base shield jobs.", inputSchema: { session: z.string(), desk_id: z.string() } }, async (args) => {
    const s = await session(auth, args);
    return ok(await store.listBaseShields(String(args.desk_id), s.address));
  });
  reg("retry_base_shield", { description: "Retry a failed Base shield job.", inputSchema: { session: z.string(), id: z.string() } }, async (args) => {
    const s = await session(auth, args);
    return ok(await store.retryBaseShield(String(args.id), s.address));
  });

  return server;
}
