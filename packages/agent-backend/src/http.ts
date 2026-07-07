// Streamable-HTTP MCP server for the agent backend, copying the packages/mcp/src/http.ts mechanics:
// the MCP endpoint at /mcp with a transport map keyed by mcp-session-id (fresh McpServer per
// initialize, shared process-wide store + auth so the challenge rate limiter survives transports),
// an idle reaper that never evicts a session with an open (SSE) stream, a CORS allowlist with a
// loopback-dev exception, a JSON body cap, and JSON-RPC error envelopes from classifyAgentError.
// Two plain-REST carve-outs stay: GET /healthz, and GET /v1/logs/public — the public feed must
// remain a browser-linkable URL, which MCP tools are not.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentAuthService } from "./auth.js";
import { agentBackendConfigFromEnv, type AgentBackendConfig } from "./config.js";
import { envNumber } from "./env.js";
import { AgentMcpError, classifyAgentError } from "./errors.js";
import { createAgentMcpServer } from "./server.js";
import { AgentBackendError, openAgentStore, type AgentStore, type LogFilter } from "./store.js";

type Transport = StreamableHTTPServerTransport;
type TransportRecord = { transport: Transport; lastUsed: number; openStreams: number };

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
  res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    req.headers["access-control-request-headers"] ??
      "accept,authorization,content-type,last-event-id,mcp-protocol-version,mcp-session-id",
  );
  res.setHeader("access-control-expose-headers", "mcp-session-id,mcp-protocol-version");
  if (req.headers["access-control-request-private-network"]) {
    res.setHeader("access-control-allow-private-network", "true");
  }
  return true;
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (maxBytes > 0 && total > maxBytes) throw new AgentBackendError(413, `request body exceeds ${maxBytes} bytes`);
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

function jsonRpcId(body: unknown): unknown {
  if (body && typeof body === "object" && "id" in body) return (body as { id?: unknown }).id ?? null;
  return null;
}

/** The REST public feed's query-string variant of the log filter (the MCP tool takes typed args). */
function logFilterFromQuery(query: URLSearchParams): LogFilter {
  const filter: LogFilter = {};
  const sessionId = query.get("session_id");
  const agentId = query.get("agent_id");
  const afterCursor = query.get("after_cursor");
  const limit = query.get("limit");
  if (sessionId) filter.sessionId = sessionId;
  if (agentId) filter.agentId = agentId;
  if (afterCursor) {
    const n = Number(afterCursor);
    if (!Number.isSafeInteger(n)) throw new AgentBackendError(400, "after_cursor must be an integer");
    filter.afterCursor = n;
  }
  if (limit) {
    const n = Number(limit);
    if (!Number.isSafeInteger(n)) throw new AgentBackendError(400, "limit must be an integer");
    filter.limit = n;
  }
  return filter;
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
  /** Origin (http://host:port) — the MCP endpoint is at /mcp, the public feed at /v1/logs/public. */
  url: string;
  store: AgentStore;
  xmtpAddress: `0x${string}` | null;
  close(): Promise<void>;
}

export async function startAgentBackend(opts: StartAgentBackendOptions = {}): Promise<AgentBackendHandle> {
  const config = opts.config ?? agentBackendConfigFromEnv();
  const store = opts.store ?? openAgentStore(config.databaseUrl);
  // One AgentAuthService for the whole process, shared across every MCP session: a fresh transport
  // is created per initialize, so per-server auth state would reset on each new session.
  const auth = opts.auth ?? new AgentAuthService(store);
  const log = { info: opts.logger?.info ?? (() => {}), warn: opts.logger?.warn ?? console.warn };

  // The inbox worker is wired in lazily (phase: xmtpInbox.ts) — until it runs, the info tool reports
  // xmtp_address: null and log ingest over XMTP is unavailable (the MCP API is unaffected).
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

  const serverDeps = { store, auth, config, xmtpAddress: () => xmtpAddress, logger: log };
  const corsOrigins = new Set(config.corsOrigins);
  const transports = new Map<string, TransportRecord>();
  const maxBodyBytes = envNumber("MOSAIC_AGENT_MAX_BODY_BYTES", 1024 * 1024, { allowZero: true });
  const transportTtlMs = envNumber("MOSAIC_AGENT_MCP_TRANSPORT_TTL_MS", 30 * 60_000, { allowZero: true });

  const cleanup = setInterval(() => {
    const cutoff = Date.now() - transportTtlMs;
    for (const [id, record] of transports) {
      // Only reap sessions that are both idle and have no open stream: a long-lived SSE (GET) stream
      // keeps the session live even with no tool calls, so evicting on lastUsed alone would tear down
      // a still-connected client mid-stream.
      if (record.openStreams <= 0 && record.lastUsed < cutoff) {
        record.transport.close?.();
        transports.delete(id);
      }
    }
  }, Math.max(transportTtlMs / 2, 30_000));
  cleanup.unref?.();

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
    if (url.pathname === "/v1/logs/public" && req.method === "GET") {
      try {
        sendJson(res, 200, { entries: await store.publicLogs(logFilterFromQuery(url.searchParams)) });
      } catch (error) {
        const classified = classifyAgentError(error);
        sendJson(res, classified.status, { error: classified.message });
      }
      return;
    }
    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    let parsedBody: unknown;
    try {
      parsedBody = req.method === "POST" ? await readJson(req, maxBodyBytes) : undefined;
      const sessionId = req.headers["mcp-session-id"];
      const record = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
      let transport = record?.transport;
      if (!record) {
        if (req.method !== "POST" || !isInitializeRequest(parsedBody)) {
          sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: initialize first" }, id: null });
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, { transport: transport!, lastUsed: Date.now(), openStreams: 0 });
          },
        });
        transport.onclose = () => {
          const id = transport?.sessionId;
          if (id) transports.delete(id);
        };
        await createAgentMcpServer(serverDeps).connect(transport);
      } else {
        // Mark the session busy for the lifetime of this request so the idle sweeper cannot reap a
        // session with an in-flight or long-lived (SSE) stream; refresh idle time when it closes.
        record.lastUsed = Date.now();
        record.openStreams += 1;
        res.on("close", () => {
          record.openStreams -= 1;
          record.lastUsed = Date.now();
        });
      }
      if (!transport) throw new AgentMcpError("INTERNAL", "MCP transport was not initialized");
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      if (!res.headersSent) {
        const classified = classifyAgentError(error);
        sendJson(res, classified.status, {
          jsonrpc: "2.0",
          error: { code: -32603, message: classified.message, data: classified.body() },
          id: jsonRpcId(parsedBody),
        });
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
      clearInterval(cleanup);
      for (const [id, record] of transports) {
        record.transport.close?.();
        transports.delete(id);
      }
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
