// node:http server over the api.ts route table, copying the MCP http.ts mechanics: parseBind,
// CORS allowlist with a loopback-dev exception, JSON body reading with a size cap, and JSON error
// bodies. No framework — the route table is a (method, regex) list.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildRoutes, type ApiDeps, type Route } from "./api.js";
import { AgentAuthService } from "./auth.js";
import { agentBackendConfigFromEnv, type AgentBackendConfig } from "./config.js";
import { AgentBackendError, openAgentStore, type AgentStore } from "./store.js";

const MAX_BODY_BYTES = 1024 * 1024;

function parseBind(bind: string): { host: string; port: number } {
  const [host, rawPort] = bind.includes(":") ? bind.split(":") : ["127.0.0.1", bind];
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0) throw new Error(`invalid MOSAIC_AGENT_BIND: ${bind}`);
  return { host: host || "127.0.0.1", port };
}

function loopbackDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
}

function writeCors(req: IncomingMessage, res: ServerResponse, allowed: Set<string>): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const ok =
    allowed.has("*") || allowed.has(origin) || (process.env.NODE_ENV !== "production" && loopbackDevOrigin(origin));
  if (!ok) return false;
  res.setHeader("access-control-allow-origin", allowed.has("*") ? "*" : origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", req.headers["access-control-request-headers"] ?? "accept,authorization,content-type");
  return true;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > MAX_BODY_BYTES) throw new AgentBackendError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buf);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AgentBackendError(400, "request body is not valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

export interface StartAgentBackendOptions {
  config?: AgentBackendConfig;
  store?: AgentStore;
  auth?: AgentAuthService;
  /** Start the XMTP inbox worker (needs config.xmtp.key). Defaults to true when a key is set. */
  startXmtp?: boolean;
  logger?: { info?(msg: string): void; warn?(msg: string): void };
}

export interface AgentBackendHandle {
  url: string;
  store: AgentStore;
  xmtpAddress: `0x${string}` | null;
  close(): Promise<void>;
}

export async function startAgentBackend(opts: StartAgentBackendOptions = {}): Promise<AgentBackendHandle> {
  const config = opts.config ?? agentBackendConfigFromEnv();
  const store = opts.store ?? openAgentStore(config.databaseUrl);
  const auth = opts.auth ?? new AgentAuthService(store);
  const log = { info: opts.logger?.info ?? (() => {}), warn: opts.logger?.warn ?? console.warn };

  // The inbox worker is wired in lazily (phase: xmtpInbox.ts) — until it runs, /v1/info reports
  // xmtp_address: null and log ingest over XMTP is unavailable (the HTTP API is unaffected).
  let xmtpAddress: `0x${string}` | null = null;
  let stopInbox: (() => Promise<void>) | null = null;
  const wantXmtp = opts.startXmtp ?? Boolean(config.xmtp.key);
  if (wantXmtp && config.xmtp.key && config.xmtp.dbKey) {
    const { startXmtpInbox } = await import("./xmtpInbox.js");
    const inbox = await startXmtpInbox(config, store, log);
    xmtpAddress = inbox.address;
    stopInbox = inbox.stop;
    log.info(`xmtp inbox listening as ${inbox.address} (${config.xmtp.env})`);
  } else if (wantXmtp) {
    log.warn("MOSAIC_AGENT_XMTP_KEY / MOSAIC_AGENT_XMTP_DB_KEY not set — XMTP log ingest disabled");
  }

  const deps: ApiDeps = { store, auth, config, xmtpAddress: () => xmtpAddress };
  const routes: Route[] = buildRoutes(deps);
  const corsOrigins = new Set(config.corsOrigins);

  const http = createServer(async (req, res) => {
    const corsOk = writeCors(req, res, corsOrigins);
    if (req.method === "OPTIONS") {
      res.writeHead(corsOk ? 204 : 403);
      res.end();
      return;
    }
    if (!corsOk) {
      sendJson(res, 403, { error: "CORS origin not allowed" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://internal");
    if (url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!route) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    try {
      const params = { ...(route.pattern.exec(url.pathname)?.groups ?? {}) };
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readJson(req);
      const result = await route.handler({ params, query: url.searchParams, body, bearer: bearerOf(req) });
      sendJson(res, result.status ?? 200, result.body);
    } catch (error) {
      if (error instanceof AgentBackendError) {
        sendJson(res, error.status, { error: error.message });
      } else {
        log.warn(`unhandled error on ${req.method} ${url.pathname}: ${error instanceof Error ? error.stack : error}`);
        sendJson(res, 500, { error: "internal error" });
      }
    }
  });

  const { host, port } = parseBind(config.bind);
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const address = http.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    url: `http://${host}:${actualPort}`,
    store,
    xmtpAddress,
    close: async () => {
      await stopInbox?.();
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
