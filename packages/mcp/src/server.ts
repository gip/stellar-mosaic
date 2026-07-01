import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BookSide, Desk, MosaicLogger, Operation, SubmitResult } from "@mosaic/sdk";
import { z } from "zod";
import { AuthService } from "./auth.js";
import { StellarBookReader } from "./book.js";
import { runBaseShield, type BaseShieldConfig as RunnerBaseShieldConfig } from "./baseShield.js";
import { SponsoredStellarDeployHandlers } from "./deploy.js";
import { createStderrLogger } from "./logging.js";
import { StellarCliRelayer } from "./relayer.js";
import { MemoryMosaicStore, type MosaicStore } from "./store.js";

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
  createDesk(body: Record<string, unknown>, creator: string): Promise<{ desk: Desk; sponsorSecret?: string | null }>;
  completeBaseDeployment(id: string, body: Record<string, unknown>, address: string): Promise<Desk>;
  baseDeploymentConfig(): Promise<unknown>;
}

export interface BookHandlers {
  getBook(args: { desk_id: string; pair: number; side: number }): Promise<BookSide>;
}

export interface MosaicMcpOptions {
  auth?: AuthService;
  store?: MosaicStore;
  relays?: RelayHandlers;
  deploy?: DeployHandlers;
  books?: BookHandlers;
  logger?: MosaicLogger;
  /** Legacy direct Base-shield runner; the durable queued flow is exposed separately. */
  baseShield?: RunnerBaseShieldConfig;
}

type ToolResult = { content: { type: "text"; text: string }[] };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const body = (args: Record<string, unknown>) => (args.body ?? {}) as Record<string, unknown>;

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
  const deploy = opts.deploy ?? new SponsoredStellarDeployHandlers();
  const books = opts.books ?? {
    getBook: async ({ desk_id, pair, side }) => new StellarBookReader().getBook(await store.getDesk(desk_id), pair, side),
  };
  const logger = opts.logger ?? createStderrLogger();
  const server = new McpServer({ name: "mosaic-mcp", version: "0.0.0" });

  const reg = (
    name: string,
    config: { description: string; inputSchema: z.ZodRawShape },
    handler: ToolHandler,
  ): void => {
    const wrapped: ToolHandler = async (args) => {
      const started = Date.now();
      logger.debug("mcp tool started", { tool: name });
      try {
        const result = await handler(args);
        logger.info("mcp tool completed", { tool: name, duration_ms: Date.now() - started });
        return result;
      } catch (error) {
        logger.error("mcp tool failed", { tool: name, duration_ms: Date.now() - started, error });
        throw error;
      }
    };
    (server.registerTool as unknown as (n: string, c: unknown, h: ToolHandler) => void)(name, config, wrapped);
  };

  reg(
    "auth_challenge",
    {
      description: "Begin wallet authentication: returns a message for the given Stellar address to sign.",
      inputSchema: { address: z.string().describe("Stellar public key (G...)") },
    },
    async ({ address }) => ok(await auth.challenge(String(address))),
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
      const created = await deploy.createDesk(body(args), s.address);
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
      return ok(await deploy.completeBaseDeployment(String(args.id), body(args), s.address));
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
      return ok(await store.createOperation(s.address, "testnet", body(args) as never, String(args.idempotency_key)));
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
    async (args) =>
      ok(
        await store.failAction(
          (await session(auth, args)).address,
          String(args.id),
          String(args.lease_token),
          String(args.error),
          Boolean(args.retryable),
        ),
      ),
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

  reg("get_wallet_backup", { description: "Read opaque wallet backup.", inputSchema: { backup_id: z.string() } }, async ({ backup_id }) =>
    ok(await store.getWalletBackup(String(backup_id))),
  );
  reg(
    "put_wallet_backup",
    { description: "Write opaque wallet backup.", inputSchema: { backup_id: z.string(), body: z.record(z.unknown()) } },
    async (args) => {
      const b = body(args);
      return ok(
        await store.putWalletBackup(String(args.backup_id), String(b.write_token), Number(b.expected_generation), {
          format_version: 1,
          generation: Number(b.generation ?? 0),
          nonce_b64: String(b.nonce_b64),
          ciphertext_b64: String(b.ciphertext_b64),
        }),
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
      await session(auth, args);
      const b = body(args);
      return ok(await store.enqueueBaseShield(String(args.desk_id), String(b.expected_bridge), Number(b.deposit_id)));
    },
  );
  reg("list_base_shields", { description: "List Base shield jobs.", inputSchema: { desk_id: z.string() } }, async ({ desk_id }) =>
    ok(await store.listBaseShields(String(desk_id))),
  );

  reg(
    "base_shield",
    {
      description: "Legacy Base -> Stellar shield runner. Requires an authenticated session.",
      inputSchema: { session: z.string(), contractId: z.string(), asset_id: z.number(), amount: z.string(), owner_tag: z.string(), baseTxHash: z.string() },
    },
    async (args) => {
      await session(auth, args);
      if (!opts.baseShield) throw new Error("Base shielding is not configured on this MCP server.");
      return ok(
        await runBaseShield(opts.baseShield, {
          contractId: String(args.contractId),
          asset_id: Number(args.asset_id),
          amount: String(args.amount),
          owner_tag: String(args.owner_tag),
          baseTxHash: String(args.baseTxHash),
        }),
      );
    },
  );

  return server;
}
