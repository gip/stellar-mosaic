// Pure route handlers: (store, auth, config) in, JSON out, AgentBackendError for failures. The
// node:http router in http.ts owns transport concerns (CORS, body reading, bearer parsing); this
// module owns semantics, so tests can drive it directly or over fetch — same behavior.

import type { AgentConfig, AgentIdentityDescriptor, RunnerState, SealedRootEnvelope } from "@mosaic/agent-sdk";
import { AgentAuthService } from "./auth.js";
import type { AgentBackendConfig } from "./config.js";
import { AgentBackendError, type AgentDataKind, type AgentStore, type LogFilter, type StoredSession } from "./store.js";

const err = (status: number, message: string) => new AgentBackendError(status, message);

export interface ApiContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  bearer?: string;
}

export interface ApiResult {
  status?: number;
  body: unknown;
}

export type ApiHandler = (ctx: ApiContext) => Promise<ApiResult>;

export interface Route {
  method: string;
  /** Path pattern with named groups for params, matched against the pathname. */
  pattern: RegExp;
  handler: ApiHandler;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw err(400, "request body must be a JSON object");
  return body as Record<string, unknown>;
}

function str(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) throw err(400, `${key} must be a non-empty string`);
  return value;
}

function optStr(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw err(400, `${key} must be a string`);
  return value;
}

function chainOf(obj: Record<string, unknown>): "stellar" | "ethereum" {
  const chain = str(obj, "chain");
  if (chain !== "stellar" && chain !== "ethereum") throw err(400, "chain must be stellar or ethereum");
  return chain;
}

function logFilter(query: URLSearchParams): LogFilter {
  const filter: LogFilter = {};
  const sessionId = query.get("session_id");
  const agentId = query.get("agent_id");
  const afterCursor = query.get("after_cursor");
  const limit = query.get("limit");
  if (sessionId) filter.sessionId = sessionId;
  if (agentId) filter.agentId = agentId;
  if (afterCursor) {
    const n = Number(afterCursor);
    if (!Number.isSafeInteger(n)) throw err(400, "after_cursor must be an integer");
    filter.afterCursor = n;
  }
  if (limit) {
    const n = Number(limit);
    if (!Number.isSafeInteger(n)) throw err(400, "limit must be an integer");
    filter.limit = n;
  }
  return filter;
}

function sealedEnvelope(obj: Record<string, unknown>): SealedRootEnvelope {
  if (obj.v !== 1) throw err(400, "sealed envelope must have v: 1");
  return { v: 1, epk: str(obj, "epk"), nonce: str(obj, "nonce"), ct: str(obj, "ct") };
}

export interface ApiDeps {
  store: AgentStore;
  auth: AgentAuthService;
  config: AgentBackendConfig;
  /** The inbox worker's XMTP address once it is up; null while disabled. */
  xmtpAddress(): `0x${string}` | null;
}

export function buildRoutes({ store, auth, config, xmtpAddress }: ApiDeps): Route[] {
  const requireMaster = (ctx: ApiContext) => auth.requireSession(ctx.bearer, "master");
  const requireRunner = (ctx: ApiContext) => auth.requireSession(ctx.bearer, "runner");
  const requireAgent = (ctx: ApiContext) => auth.requireSession(ctx.bearer, "agent");

  async function ownedAgent(session: StoredSession & { kind: "master" }, agentId: string) {
    const agent = await store.getAgent(agentId);
    if (agent.master_id !== session.master_id) throw err(404, `agent ${agentId} not found`);
    return agent;
  }

  async function attachedSnapshot(agentId: string): Promise<Record<string, unknown>> {
    const data = await store.agentData(agentId, "attached");
    return Object.fromEntries(Object.entries(data).map(([key, stored]) => [key, stored.value]));
  }

  const routes: Route[] = [
    {
      method: "GET",
      pattern: /^\/v1\/info$/,
      handler: async () => ({
        body: {
          xmtp_address: xmtpAddress(),
          xmtp_env: config.xmtp.env,
          network_passphrase: config.networkPassphrase,
          derivation_version: 1,
        },
      }),
    },

    // -- master auth --------------------------------------------------------
    {
      method: "POST",
      pattern: /^\/v1\/auth\/challenge$/,
      handler: async (ctx) => {
        const body = asObject(ctx.body);
        return { body: await auth.masterChallenge(chainOf(body), str(body, "address")) };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/auth\/verify$/,
      handler: async (ctx) => {
        const body = asObject(ctx.body);
        return {
          body: await auth.masterVerify(chainOf(body), str(body, "address"), str(body, "challenge_id"), str(body, "signature")),
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/auth\/logout$/,
      handler: async (ctx) => {
        await auth.logout(ctx.bearer);
        return { body: { ok: true } };
      },
    },

    // -- master: agents -------------------------------------------------------
    {
      method: "POST",
      pattern: /^\/v1\/agents$/,
      handler: async (ctx) => {
        const session = await requireMaster(ctx);
        const descriptor = asObject(ctx.body) as unknown as AgentIdentityDescriptor;
        if (descriptor.network_passphrase !== config.networkPassphrase) {
          throw err(400, `descriptor network_passphrase must be "${config.networkPassphrase}"`);
        }
        const expectedMaster = `${descriptor.master_chain}:${
          descriptor.master_chain === "ethereum" ? descriptor.master_address?.toLowerCase() : descriptor.master_address
        }`;
        if (expectedMaster !== session.master_id) throw err(403, "descriptor master does not match the authenticated master");
        return { status: 201, body: await store.registerAgent(session.master_id, descriptor) };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/agents$/,
      handler: async (ctx) => {
        const session = await requireMaster(ctx);
        return { body: await store.listAgents(session.master_id) };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/agents\/(?<id>[^/]+)$/,
      handler: async (ctx) => {
        const session = await requireMaster(ctx);
        return { body: await ownedAgent(session, ctx.params.id) };
      },
    },
    {
      method: "DELETE",
      pattern: /^\/v1\/agents\/(?<id>[^/]+)$/,
      handler: async (ctx) => {
        const session = await requireMaster(ctx);
        await ownedAgent(session, ctx.params.id);
        return { body: await store.revokeAgent(session.master_id, ctx.params.id) };
      },
    },
    {
      method: "PUT",
      pattern: /^\/v1\/agents\/(?<id>[^/]+)\/desired-state$/,
      handler: async (ctx) => {
        const session = await requireMaster(ctx);
        const state = str(asObject(ctx.body), "state");
        if (state !== "running" && state !== "stopped") throw err(400, "state must be running or stopped");
        await ownedAgent(session, ctx.params.id);
        return { body: await store.setDesiredState(session.master_id, ctx.params.id, state) };
      },
    },
    {
      method: "PUT",
      pattern: /^\/v1\/agents\/(?<id>[^/]+)\/data\/(?<key>[^/]+)$/,
      handler: async (ctx) => {
        const session = await requireMaster(ctx);
        const body = asObject(ctx.body);
        if (!("value" in body)) throw err(400, "body must have a value field");
        await ownedAgent(session, ctx.params.id);
        await store.putAgentData(ctx.params.id, "attached", decodeURIComponent(ctx.params.key), body.value, session.master_id);
        return { body: { ok: true } };
      },
    },
    {
      method: "DELETE",
      pattern: /^\/v1\/agents\/(?<id>[^/]+)\/data\/(?<key>[^/]+)$/,
      handler: async (ctx) => {
        const session = await requireMaster(ctx);
        await ownedAgent(session, ctx.params.id);
        await store.deleteAgentData(ctx.params.id, "attached", decodeURIComponent(ctx.params.key));
        return { body: { ok: true } };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/agents\/(?<id>[^/]+)\/data$/,
      handler: async (ctx) => {
        const session = await requireMaster(ctx);
        await ownedAgent(session, ctx.params.id);
        return {
          body: {
            attached: await store.agentData(ctx.params.id, "attached"),
            scratch: await store.agentData(ctx.params.id, "scratch"),
          },
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/agents\/(?<id>[^/]+)\/sessions$/,
      handler: async (ctx) => {
        const session = await requireMaster(ctx);
        await ownedAgent(session, ctx.params.id);
        return { body: await store.listAgentSessions(ctx.params.id) };
      },
    },
    {
      method: "PUT",
      pattern: /^\/v1\/agents\/(?<id>[^/]+)\/sealed-keys\/(?<runnerId>[^/]+)$/,
      handler: async (ctx) => {
        const session = await requireMaster(ctx);
        const envelope = sealedEnvelope(asObject(ctx.body));
        await store.putSealedRoot(session.master_id, ctx.params.id, ctx.params.runnerId, envelope);
        return { body: { ok: true } };
      },
    },

    // -- master: runners ------------------------------------------------------
    {
      method: "POST",
      pattern: /^\/v1\/runners$/,
      handler: async (ctx) => {
        const session = await requireMaster(ctx);
        const body = asObject(ctx.body);
        const name = optStr(body, "name");
        const runtimeVersion = optStr(body, "runtime_version");
        return {
          status: 201,
          body: await store.registerRunner(session.master_id, {
            auth_public_key: str(body, "auth_public_key"),
            seal_public_key: str(body, "seal_public_key"),
            ...(name !== undefined ? { name } : {}),
            ...(runtimeVersion !== undefined ? { runtime_version: runtimeVersion } : {}),
          }),
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/runners$/,
      handler: async (ctx) => {
        const session = await requireMaster(ctx);
        return { body: await store.listRunners(session.master_id) };
      },
    },
    {
      method: "PUT",
      pattern: /^\/v1\/runners\/(?<id>[^/]+)$/,
      handler: async (ctx) => {
        const session = await requireMaster(ctx);
        const body = asObject(ctx.body);
        const name = optStr(body, "name");
        const runtimeVersion = optStr(body, "runtime_version");
        return {
          body: await store.updateRunner(session.master_id, ctx.params.id, {
            ...(name !== undefined ? { name } : {}),
            ...(runtimeVersion !== undefined ? { runtime_version: runtimeVersion } : {}),
          }),
        };
      },
    },
    {
      method: "DELETE",
      pattern: /^\/v1\/runners\/(?<id>[^/]+)$/,
      handler: async (ctx) => {
        const session = await requireMaster(ctx);
        return { body: await store.revokeRunner(session.master_id, ctx.params.id) };
      },
    },

    // -- master: logs ---------------------------------------------------------
    {
      method: "GET",
      pattern: /^\/v1\/logs$/,
      handler: async (ctx) => {
        const session = await requireMaster(ctx);
        return { body: { entries: await store.masterLogs(session.master_id, logFilter(ctx.query)) } };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/sessions\/(?<id>[^/]+)\/logs$/,
      handler: async (ctx) => {
        // Master (owner) or the session's own agent.
        const session = await auth.requireSession(ctx.bearer);
        const agentSession = await store.getAgentSession(ctx.params.id);
        if (!agentSession) throw err(404, "session not found");
        if (session.kind === "master") {
          const agent = await store.getAgent(agentSession.agent_id);
          if (agent.master_id !== session.master_id) throw err(404, "session not found");
        } else if (session.kind === "agent") {
          if (session.agent_id !== agentSession.agent_id) throw err(403, "not this agent's session");
        } else {
          throw err(403, "this route needs a master or agent session");
        }
        return { body: { entries: await store.logsBySession(ctx.params.id) } };
      },
    },

    // -- public ---------------------------------------------------------------
    {
      method: "GET",
      pattern: /^\/v1\/logs\/public$/,
      handler: async (ctx) => ({ body: { entries: await store.publicLogs(logFilter(ctx.query)) } }),
    },

    // -- runner ---------------------------------------------------------------
    {
      method: "POST",
      pattern: /^\/v1\/runner\/auth\/challenge$/,
      handler: async (ctx) => ({ body: await auth.runnerChallenge(str(asObject(ctx.body), "runner_id")) }),
    },
    {
      method: "POST",
      pattern: /^\/v1\/runner\/auth\/verify$/,
      handler: async (ctx) => {
        const body = asObject(ctx.body);
        return { body: await auth.runnerVerify(str(body, "runner_id"), str(body, "challenge_id"), str(body, "signature")) };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/runner\/state$/,
      handler: async (ctx) => {
        const session = await requireRunner(ctx);
        const runner = await store.getRunner(session.runner_id);
        if (runner.revoked) throw err(404, "runner not found");
        const agents = await store.listAgents(session.master_id);
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
        return { body: state };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/runner\/heartbeat$/,
      handler: async (ctx) => {
        const session = await requireRunner(ctx);
        const body = asObject(ctx.body);
        const { conflict } = await store.heartbeatRunner(session.runner_id, str(body, "instance_id"));
        return { body: { ok: true, ...(conflict ? { conflict: true } : {}) } };
      },
    },

    // -- agent ------------------------------------------------------------------
    {
      method: "POST",
      pattern: /^\/v1\/agent\/auth\/challenge$/,
      handler: async (ctx) => ({ body: await auth.agentChallenge(str(asObject(ctx.body), "stellar_public_key")) }),
    },
    {
      method: "POST",
      pattern: /^\/v1\/agent\/auth\/verify$/,
      handler: async (ctx) => {
        const body = asObject(ctx.body);
        const result = await auth.agentVerify(str(body, "stellar_public_key"), str(body, "challenge_id"), str(body, "signature"));
        return {
          body: {
            token: result.token,
            session_id: result.session.id,
            agent: result.agent,
            attached: await attachedSnapshot(result.agent.id),
            expires_at: result.expires_at,
          },
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/agent\/data$/,
      handler: async (ctx) => {
        const session = await requireAgent(ctx);
        return {
          body: {
            attached: await store.agentData(session.agent_id, "attached"),
            scratch: await store.agentData(session.agent_id, "scratch"),
          },
        };
      },
    },
    {
      method: "PUT",
      pattern: /^\/v1\/agent\/scratch\/(?<key>[^/]+)$/,
      handler: async (ctx) => {
        const session = await requireAgent(ctx);
        const body = asObject(ctx.body);
        if (!("value" in body)) throw err(400, "body must have a value field");
        await store.putAgentData(session.agent_id, "scratch", decodeURIComponent(ctx.params.key), body.value, session.agent_id);
        return { body: { ok: true } };
      },
    },
    {
      method: "DELETE",
      pattern: /^\/v1\/agent\/scratch\/(?<key>[^/]+)$/,
      handler: async (ctx) => {
        const session = await requireAgent(ctx);
        await store.deleteAgentData(session.agent_id, "scratch", decodeURIComponent(ctx.params.key));
        return { body: { ok: true } };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/agent\/session\/end$/,
      handler: async (ctx) => {
        const session = await requireAgent(ctx);
        await store.endAgentSession(session.session_id);
        return { body: { ok: true } };
      },
    },
  ];

  return routes;
}

/** Look up a data kind by name (used by the inbox worker's tests). */
export function isAgentDataKind(value: string): value is AgentDataKind {
  return value === "attached" || value === "scratch";
}
