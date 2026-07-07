// The agent backend's MCP tool surface, replacing the former REST route table (api.ts). Copies the
// packages/mcp/src/server.ts mechanics: one McpServer per transport, a reg() helper that wraps every
// tool with logging + a slow-call watchdog + a per-call timeout, ok()/fail() text results with the
// protocol-level isError flag, and auth as a `session` token argument on every authenticated tool
// (never bound to the transport's mcp-session-id). Handlers keep throwing AgentBackendError with the
// original HTTP statuses; classifyAgentError maps them into the typed error body at the boundary.
//
// Schemas are deliberately loose (optional zod fields, strict checks in the handlers) so validation
// failures surface as the same AgentBackendError(400, ...) messages the REST API returned, inside a
// parseable error body — not as MCP SDK argument-validation strings.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentConfig, AgentIdentityDescriptor, RunnerState, SealedRootEnvelope } from "@mosaic/agent-sdk";
import { AgentAuthService } from "./auth.js";
import type { AgentBackendConfig } from "./config.js";
import { envNumber } from "./env.js";
import { AgentMcpError, agentErrorContent } from "./errors.js";
import { AgentBackendError, type AgentStore, type LogFilter, type StoredSession } from "./store.js";

const err = (status: number, message: string) => new AgentBackendError(status, message);

export interface AgentMcpDeps {
  store: AgentStore;
  auth: AgentAuthService;
  config: AgentBackendConfig;
  /** The inbox worker's XMTP address once it is up; null while disabled. */
  xmtpAddress(): `0x${string}` | null;
  logger?: { info?(msg: string): void; warn?(msg: string): void };
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
// A tool failure must set the protocol-level `isError` flag, not just embed the body in the text —
// otherwise a generic MCP client reads the failure as a successful result. The structured
// MosaicMcpErrorBody rides along in the text for AgentBackendClient to rebuild status codes from.
const fail = (error: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ ok: false, ...agentErrorContent(error) }) }],
  isError: true,
});

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) throw err(400, `${key} must be a non-empty string`);
  return value;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw err(400, `${key} must be a string`);
  return value;
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw err(400, `${what} must be a JSON object`);
  return value as Record<string, unknown>;
}

function chainOf(args: Record<string, unknown>): "stellar" | "ethereum" {
  const chain = str(args, "chain");
  if (chain !== "stellar" && chain !== "ethereum") throw err(400, "chain must be stellar or ethereum");
  return chain;
}

function optInt(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw err(400, `${key} must be an integer`);
  return value;
}

export function logFilterFromArgs(args: Record<string, unknown>): LogFilter {
  const filter: LogFilter = {};
  const sessionId = optStr(args, "session_id");
  const agentId = optStr(args, "agent_id");
  const afterCursor = optInt(args, "after_cursor");
  const limit = optInt(args, "limit");
  if (sessionId) filter.sessionId = sessionId;
  if (agentId) filter.agentId = agentId;
  if (afterCursor !== undefined) filter.afterCursor = afterCursor;
  if (limit !== undefined) filter.limit = limit;
  return filter;
}

function sealedEnvelope(value: unknown): SealedRootEnvelope {
  const obj = asObject(value, "envelope");
  if (obj.v !== 1) throw err(400, "sealed envelope must have v: 1");
  return { v: 1, epk: str(obj, "epk"), nonce: str(obj, "nonce"), ct: str(obj, "ct") };
}

const logFilterShape = {
  session_id: z.string().optional(),
  agent_id: z.string().optional(),
  after_cursor: z.number().optional(),
  limit: z.number().optional(),
};

const slowToolThresholdMs = (): number => envNumber("MOSAIC_AGENT_MCP_SLOW_TOOL_MS", 15_000, { allowZero: true });
const toolTimeoutMs = (): number => envNumber("MOSAIC_AGENT_MCP_TOOL_TIMEOUT_MS", 120_000, { allowZero: true });

export function createAgentMcpServer({ store, auth, config, xmtpAddress, logger }: AgentMcpDeps): McpServer {
  const log = { info: logger?.info ?? (() => {}), warn: logger?.warn ?? (() => {}) };
  const slowMs = slowToolThresholdMs();
  const timeoutMs = toolTimeoutMs();
  const server = new McpServer({ name: "mosaic-agent-backend", version: "0.0.0" });

  const reg = (
    name: string,
    toolConfig: { description: string; inputSchema: z.ZodRawShape },
    handler: ToolHandler,
  ): void => {
    const wrapped: ToolHandler = async (args) => {
      const started = Date.now();
      // Emit a warn line once the call crosses the slow threshold, then keep ticking, so a call the
      // client eventually abandons with `-32001 Request timed out` is named in this log while it is
      // still running (unref'd so it never keeps the process alive).
      const watchdog =
        slowMs > 0
          ? setInterval(() => log.warn(`mcp tool ${name} still running after ${Date.now() - started}ms`), slowMs)
          : undefined;
      watchdog?.unref?.();
      try {
        const run = handler(args);
        return timeoutMs > 0
          ? await Promise.race([
              run,
              new Promise<ToolResult>((_resolve, reject) =>
                setTimeout(() => reject(new AgentMcpError("TIMEOUT", `MCP tool ${name} timed out after ${timeoutMs}ms`)), timeoutMs).unref?.(),
              ),
            ])
          : await run;
      } catch (error) {
        log.warn(`mcp tool ${name} failed after ${Date.now() - started}ms: ${error instanceof Error ? error.message : error}`);
        return fail(error);
      } finally {
        if (watchdog) clearInterval(watchdog);
      }
    };
    (server.registerTool as unknown as (n: string, c: unknown, h: ToolHandler) => void)(name, toolConfig, wrapped);
  };

  const token = (args: Record<string, unknown>): string | undefined => {
    const session = args.session;
    return typeof session === "string" && session.length > 0 ? session : undefined;
  };
  const requireMaster = (args: Record<string, unknown>) => auth.requireSession(token(args), "master");
  const requireRunner = (args: Record<string, unknown>) => auth.requireSession(token(args), "runner");
  const requireAgent = (args: Record<string, unknown>) => auth.requireSession(token(args), "agent");

  async function ownedAgent(session: StoredSession & { kind: "master" }, agentId: string) {
    const agent = await store.getAgent(agentId);
    if (agent.master_id !== session.master_id) throw err(404, `agent ${agentId} not found`);
    return agent;
  }

  async function attachedSnapshot(agentId: string): Promise<Record<string, unknown>> {
    const data = await store.agentData(agentId, "attached");
    return Object.fromEntries(Object.entries(data).map(([key, stored]) => [key, stored.value]));
  }

  // Optional in the schema so a missing token reaches requireSession and comes back as the typed
  // 401 body (AUTH_INVALID), not as an SDK argument-validation string the client cannot parse.
  const session = { session: z.string().optional().describe("Bearer session token from an auth verify tool") };

  reg(
    "info",
    { description: "Backend identity: XMTP inbox address/env, network passphrase, derivation version.", inputSchema: {} },
    async () =>
      ok({
        xmtp_address: xmtpAddress(),
        xmtp_env: config.xmtp.env,
        network_passphrase: config.networkPassphrase,
        derivation_version: 1,
      }),
  );

  // -- auth: master -----------------------------------------------------------

  reg(
    "master_auth_challenge",
    {
      description: "Begin master authentication: returns a message for the wallet to sign.",
      inputSchema: { chain: z.string().optional().describe("stellar | ethereum"), address: z.string().optional() },
    },
    async (args) => ok(await auth.masterChallenge(chainOf(args), str(args, "address"))),
  );

  reg(
    "master_auth_verify",
    {
      description: "Complete master authentication with the signed challenge; returns a session token.",
      inputSchema: {
        chain: z.string().optional(),
        address: z.string().optional(),
        challenge_id: z.string().optional(),
        signature: z.string().optional(),
      },
    },
    async (args) => ok(await auth.masterVerify(chainOf(args), str(args, "address"), str(args, "challenge_id"), str(args, "signature"))),
  );

  reg(
    "logout",
    { description: "Invalidate a session token (any principal).", inputSchema: { session: z.string().optional() } },
    async (args) => {
      await auth.logout(token(args));
      return ok({ ok: true });
    },
  );

  // -- auth: runner -------------------------------------------------------------

  reg(
    "runner_auth_challenge",
    { description: "Begin runner authentication for a registered runner id.", inputSchema: { runner_id: z.string().optional() } },
    async (args) => ok(await auth.runnerChallenge(str(args, "runner_id"))),
  );

  reg(
    "runner_auth_verify",
    {
      description: "Complete runner authentication; returns a runner session token.",
      inputSchema: { runner_id: z.string().optional(), challenge_id: z.string().optional(), signature: z.string().optional() },
    },
    async (args) => ok(await auth.runnerVerify(str(args, "runner_id"), str(args, "challenge_id"), str(args, "signature"))),
  );

  // -- auth: agent ----------------------------------------------------------------

  reg(
    "agent_auth_challenge",
    { description: "Begin agent authentication for a registered agent identity.", inputSchema: { stellar_public_key: z.string().optional() } },
    async (args) => ok(await auth.agentChallenge(str(args, "stellar_public_key"))),
  );

  reg(
    "agent_auth_verify",
    {
      description: "Complete agent authentication; opens an agent session and returns its token.",
      inputSchema: { stellar_public_key: z.string().optional(), challenge_id: z.string().optional(), signature: z.string().optional() },
    },
    async (args) => {
      const result = await auth.agentVerify(str(args, "stellar_public_key"), str(args, "challenge_id"), str(args, "signature"));
      return ok({
        token: result.token,
        session_id: result.session.id,
        agent: result.agent,
        attached: await attachedSnapshot(result.agent.id),
        expires_at: result.expires_at,
      });
    },
  );

  // -- master: agents -------------------------------------------------------------

  reg(
    "register_agent",
    {
      description: "Register an agent identity descriptor under the authenticated master.",
      inputSchema: { ...session, descriptor: z.record(z.unknown()).optional() },
    },
    async (args) => {
      const s = await requireMaster(args);
      const descriptor = asObject(args.descriptor, "descriptor") as unknown as AgentIdentityDescriptor;
      if (descriptor.network_passphrase !== config.networkPassphrase) {
        throw err(400, `descriptor network_passphrase must be "${config.networkPassphrase}"`);
      }
      const expectedMaster = `${descriptor.master_chain}:${
        descriptor.master_chain === "ethereum" ? descriptor.master_address?.toLowerCase() : descriptor.master_address
      }`;
      if (expectedMaster !== s.master_id) throw err(403, "descriptor master does not match the authenticated master");
      return ok(await store.registerAgent(s.master_id, descriptor));
    },
  );

  reg("list_agents", { description: "List the authenticated master's agents.", inputSchema: { ...session } }, async (args) => {
    const s = await requireMaster(args);
    return ok(await store.listAgents(s.master_id));
  });

  reg(
    "get_agent",
    { description: "Fetch one of the authenticated master's agents.", inputSchema: { ...session, agent_id: z.string().optional() } },
    async (args) => {
      const s = await requireMaster(args);
      return ok(await ownedAgent(s, str(args, "agent_id")));
    },
  );

  reg(
    "revoke_agent",
    { description: "Revoke one of the authenticated master's agents.", inputSchema: { ...session, agent_id: z.string().optional() } },
    async (args) => {
      const s = await requireMaster(args);
      const agentId = str(args, "agent_id");
      await ownedAgent(s, agentId);
      return ok(await store.revokeAgent(s.master_id, agentId));
    },
  );

  reg(
    "set_desired_state",
    {
      description: "Set an agent's desired runtime state (running | stopped).",
      inputSchema: { ...session, agent_id: z.string().optional(), state: z.string().optional() },
    },
    async (args) => {
      const s = await requireMaster(args);
      const agentId = str(args, "agent_id");
      const state = str(args, "state");
      if (state !== "running" && state !== "stopped") throw err(400, "state must be running or stopped");
      await ownedAgent(s, agentId);
      return ok(await store.setDesiredState(s.master_id, agentId, state));
    },
  );

  reg(
    "put_attached_data",
    {
      description: "Attach a key/value to an agent (master-managed data, e.g. agent-config).",
      inputSchema: { ...session, agent_id: z.string().optional(), key: z.string().optional(), value: z.unknown().optional() },
    },
    async (args) => {
      const s = await requireMaster(args);
      const agentId = str(args, "agent_id");
      if (!("value" in args)) throw err(400, "value is required");
      await ownedAgent(s, agentId);
      await store.putAgentData(agentId, "attached", str(args, "key"), args.value, s.master_id);
      return ok({ ok: true });
    },
  );

  reg(
    "delete_attached_data",
    {
      description: "Delete an attached key from an agent.",
      inputSchema: { ...session, agent_id: z.string().optional(), key: z.string().optional() },
    },
    async (args) => {
      const s = await requireMaster(args);
      const agentId = str(args, "agent_id");
      await ownedAgent(s, agentId);
      await store.deleteAgentData(agentId, "attached", str(args, "key"));
      return ok({ ok: true });
    },
  );

  reg(
    "agent_data_of",
    { description: "Read an agent's attached + scratch data (master view).", inputSchema: { ...session, agent_id: z.string().optional() } },
    async (args) => {
      const s = await requireMaster(args);
      const agentId = str(args, "agent_id");
      await ownedAgent(s, agentId);
      return ok({
        attached: await store.agentData(agentId, "attached"),
        scratch: await store.agentData(agentId, "scratch"),
      });
    },
  );

  reg(
    "agent_sessions",
    { description: "List an agent's sessions.", inputSchema: { ...session, agent_id: z.string().optional() } },
    async (args) => {
      const s = await requireMaster(args);
      const agentId = str(args, "agent_id");
      await ownedAgent(s, agentId);
      return ok(await store.listAgentSessions(agentId));
    },
  );

  reg(
    "put_sealed_root",
    {
      description: "Store an agent root sealed to a runner's X25519 key.",
      inputSchema: { ...session, agent_id: z.string().optional(), runner_id: z.string().optional(), envelope: z.record(z.unknown()).optional() },
    },
    async (args) => {
      const s = await requireMaster(args);
      await store.putSealedRoot(s.master_id, str(args, "agent_id"), str(args, "runner_id"), sealedEnvelope(args.envelope));
      return ok({ ok: true });
    },
  );

  // -- master: runners --------------------------------------------------------------

  reg(
    "register_runner",
    {
      description: "Register a runner (its ed25519 auth key and X25519 seal key).",
      inputSchema: {
        ...session,
        auth_public_key: z.string().optional(),
        seal_public_key: z.string().optional(),
        name: z.string().optional(),
        runtime_version: z.string().optional(),
      },
    },
    async (args) => {
      const s = await requireMaster(args);
      const name = optStr(args, "name");
      const runtimeVersion = optStr(args, "runtime_version");
      return ok(
        await store.registerRunner(s.master_id, {
          auth_public_key: str(args, "auth_public_key"),
          seal_public_key: str(args, "seal_public_key"),
          ...(name !== undefined ? { name } : {}),
          ...(runtimeVersion !== undefined ? { runtime_version: runtimeVersion } : {}),
        }),
      );
    },
  );

  reg("list_runners", { description: "List the authenticated master's runners.", inputSchema: { ...session } }, async (args) => {
    const s = await requireMaster(args);
    return ok(await store.listRunners(s.master_id));
  });

  reg(
    "update_runner",
    {
      description: "Update a runner's name or runtime version.",
      inputSchema: { ...session, runner_id: z.string().optional(), name: z.string().optional(), runtime_version: z.string().optional() },
    },
    async (args) => {
      const s = await requireMaster(args);
      const name = optStr(args, "name");
      const runtimeVersion = optStr(args, "runtime_version");
      return ok(
        await store.updateRunner(s.master_id, str(args, "runner_id"), {
          ...(name !== undefined ? { name } : {}),
          ...(runtimeVersion !== undefined ? { runtime_version: runtimeVersion } : {}),
        }),
      );
    },
  );

  reg(
    "revoke_runner",
    { description: "Revoke a runner.", inputSchema: { ...session, runner_id: z.string().optional() } },
    async (args) => {
      const s = await requireMaster(args);
      return ok(await store.revokeRunner(s.master_id, str(args, "runner_id")));
    },
  );

  // -- logs -----------------------------------------------------------------------

  reg(
    "master_logs",
    { description: "Read session logs across the authenticated master's agents.", inputSchema: { ...session, ...logFilterShape } },
    async (args) => {
      const s = await requireMaster(args);
      return ok({ entries: await store.masterLogs(s.master_id, logFilterFromArgs(args)) });
    },
  );

  reg(
    "session_logs",
    {
      description: "Read one agent session's logs (owner master or the session's own agent).",
      inputSchema: { ...session, session_id: z.string().optional() },
    },
    async (args) => {
      const s = await auth.requireSession(token(args));
      const sessionId = str(args, "session_id");
      const agentSession = await store.getAgentSession(sessionId);
      if (!agentSession) throw err(404, "session not found");
      if (s.kind === "master") {
        const agent = await store.getAgent(agentSession.agent_id);
        if (agent.master_id !== s.master_id) throw err(404, "session not found");
      } else if (s.kind === "agent") {
        if (s.agent_id !== agentSession.agent_id) throw err(403, "not this agent's session");
      } else {
        throw err(403, "this tool needs a master or agent session");
      }
      return ok({ entries: await store.logsBySession(sessionId) });
    },
  );

  reg(
    "public_logs",
    { description: "Read the public session-log feed (no auth). Also served as GET /v1/logs/public.", inputSchema: { ...logFilterShape } },
    async (args) => ok({ entries: await store.publicLogs(logFilterFromArgs(args)) }),
  );

  // -- runner -----------------------------------------------------------------------

  reg(
    "runner_state",
    { description: "The runner's reconciliation view: its agents, configs, and sealed roots.", inputSchema: { ...session } },
    async (args) => {
      const s = await requireRunner(args);
      const runner = await store.getRunner(s.runner_id);
      if (runner.revoked) throw err(404, "runner not found");
      const agents = await store.listAgents(s.master_id);
      const state: RunnerState = {
        runner: { id: runner.id, runtime_version: runner.runtime_version },
        agents: await Promise.all(
          agents.map(async (agent) => {
            const attached = await store.agentData(agent.id, "attached");
            return {
              agent,
              config: (attached["agent-config"]?.value as AgentConfig | undefined) ?? null,
              sealed_root: await store.sealedRoot(agent.id, runner.id),
            };
          }),
        ),
      };
      return ok(state);
    },
  );

  reg(
    "runner_heartbeat",
    { description: "Runner liveness heartbeat; flags instance-id conflicts.", inputSchema: { ...session, instance_id: z.string().optional() } },
    async (args) => {
      const s = await requireRunner(args);
      const { conflict } = await store.heartbeatRunner(s.runner_id, str(args, "instance_id"));
      return ok({ ok: true, ...(conflict ? { conflict: true } : {}) });
    },
  );

  // -- agent ------------------------------------------------------------------------

  reg(
    "agent_data",
    { description: "The authenticated agent's attached + scratch data.", inputSchema: { ...session } },
    async (args) => {
      const s = await requireAgent(args);
      return ok({
        attached: await store.agentData(s.agent_id, "attached"),
        scratch: await store.agentData(s.agent_id, "scratch"),
      });
    },
  );

  reg(
    "put_scratch",
    {
      description: "Write a key in the authenticated agent's scratch space.",
      inputSchema: { ...session, key: z.string().optional(), value: z.unknown().optional() },
    },
    async (args) => {
      const s = await requireAgent(args);
      if (!("value" in args)) throw err(400, "value is required");
      await store.putAgentData(s.agent_id, "scratch", str(args, "key"), args.value, s.agent_id);
      return ok({ ok: true });
    },
  );

  reg(
    "delete_scratch",
    { description: "Delete a key from the authenticated agent's scratch space.", inputSchema: { ...session, key: z.string().optional() } },
    async (args) => {
      const s = await requireAgent(args);
      await store.deleteAgentData(s.agent_id, "scratch", str(args, "key"));
      return ok({ ok: true });
    },
  );

  reg(
    "end_agent_session",
    { description: "Mark the authenticated agent's session as ended.", inputSchema: { ...session } },
    async (args) => {
      const s = await requireAgent(args);
      await store.endAgentSession(s.session_id);
      return ok({ ok: true });
    },
  );

  return server;
}
