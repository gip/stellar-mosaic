import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MemoryMosaicStore } from "../dist/store.js";
import { startHttpServer } from "../dist/http.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("HTTP health and readiness expose process and dependency state", async () => {
  const mock = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, method: req.method }));
  });
  const mockUrl = await listen(mock);
  const oldRpc = process.env.MOSAIC_RPC;
  process.env.MOSAIC_RPC = mockUrl;
  const server = await startHttpServer({ bind: "127.0.0.1:0", store: new MemoryMosaicStore() });
  try {
    const base = server.url.replace(/\/mcp$/, "");
    assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
    const readyRes = await fetch(`${base}/readyz`);
    assert.equal(readyRes.status, 200);
    const ready = await readyRes.json();
    assert.equal(ready.ok, true);
    assert.equal(ready.checks.store.ok, true);
    assert.equal(ready.checks.base_shield_worker.running, false);
  } finally {
    await server.close();
    await close(mock);
    if (oldRpc === undefined) delete process.env.MOSAIC_RPC;
    else process.env.MOSAIC_RPC = oldRpc;
  }
});

test("HTTP rejects disallowed CORS origins", async () => {
  const server = await startHttpServer({ bind: "127.0.0.1:0", store: new MemoryMosaicStore(), corsOrigin: "http://allowed.example" });
  try {
    const res = await fetch(server.url.replace(/\/mcp$/, "/healthz"), { headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 403);
  } finally {
    await server.close();
  }
});

test("HTTP body limit returns a structured JSON-RPC error", async () => {
  const oldLimit = process.env.MOSAIC_MCP_MAX_BODY_BYTES;
  process.env.MOSAIC_MCP_MAX_BODY_BYTES = "20";
  const server = await startHttpServer({ bind: "127.0.0.1:0", store: new MemoryMosaicStore() });
  try {
    const res = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "too-large", method: "initialize", params: { payload: "x".repeat(100) } }),
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error.data.code, "VALIDATION_FAILED");
  } finally {
    await server.close();
    if (oldLimit === undefined) delete process.env.MOSAIC_MCP_MAX_BODY_BYTES;
    else process.env.MOSAIC_MCP_MAX_BODY_BYTES = oldLimit;
  }
});
