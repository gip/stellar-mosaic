import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { baseShieldConfigFromEnv } from "./baseShield.js";
import { createMosaicMcpServer, type MosaicMcpOptions } from "./server.js";
import { openMosaicStore } from "./store.js";

export interface HttpServerOptions extends MosaicMcpOptions {
  bind?: string;
  corsOrigin?: string;
}

type Transport = StreamableHTTPServerTransport;

function parseBind(bind: string): { host: string; port: number } {
  const [host, rawPort] = bind.includes(":") ? bind.split(":") : ["127.0.0.1", bind];
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error(`invalid MOSAIC_BIND: ${bind}`);
  return { host: host || "127.0.0.1", port };
}

function parseOrigins(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function loopbackDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeCors(req: IncomingMessage, res: ServerResponse, allowedOrigins: Set<string>): boolean {
  const origin = req.headers.origin;
  const allowed =
    typeof origin === "string" &&
    (allowedOrigins.has("*") || allowedOrigins.has(origin) || (process.env.NODE_ENV !== "production" && loopbackDevOrigin(origin)));
  if (!origin) return true;
  if (!allowed) return false;
  res.setHeader("access-control-allow-origin", allowedOrigins.has("*") ? "*" : origin);
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startHttpServer(opts: HttpServerOptions = {}): Promise<{ close(): Promise<void>; url: string }> {
  const bind = opts.bind ?? process.env.MOSAIC_BIND ?? "127.0.0.1:8788";
  const { host, port } = parseBind(bind);
  const corsOrigins = parseOrigins(
    opts.corsOrigin ??
      process.env.MOSAIC_CORS_ORIGIN ??
      "http://localhost:5173,http://127.0.0.1:5173",
  );
  const store = opts.store ?? openMosaicStore(process.env.MOSAIC_DATABASE_URL);
  const transports = new Map<string, Transport>();
  const serverOptions: MosaicMcpOptions = {
    ...opts,
    store,
    baseShield: opts.baseShield ?? baseShieldConfigFromEnv(),
  };

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
    if (req.url?.split("?")[0] !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    try {
      const parsedBody = req.method === "POST" ? await readJson(req) : undefined;
      const sessionId = req.headers["mcp-session-id"];
      let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
      if (!transport) {
        if (req.method !== "POST" || !isInitializeRequest(parsedBody)) {
          sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: initialize first" }, id: null });
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
        });
        transport.onclose = () => {
          const id = transport?.sessionId;
          if (id) transports.delete(id);
        };
        await createMosaicMcpServer(serverOptions).connect(transport);
      }
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          id: null,
        });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => {
      http.off("error", reject);
      resolve();
    });
  });

  return {
    url: `http://${host}:${port}/mcp`,
    close: () =>
      new Promise((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
