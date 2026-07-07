// Full MCP surface against an in-process server (memory store, XMTP off, port 0). Exercises the
// three auth scopes end to end with real signatures, ownership boundaries, the typed error body
// (status codes must survive the MCP round trip — the runner daemon's re-auth keys on 401), and
// the plain-REST carve-outs (/healthz, /v1/logs/public) plus the transport-level guards.

import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Keypair } from "@stellar/stellar-sdk";
import { sep53Digest } from "@mosaic/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  deriveAgentRoot,
  deriveRunnerKeys,
  generateRunnerSecret,
  sealAgentRoot,
  openAgentRoot,
  toHex,
} from "@mosaic/agent-sdk";
import { MemoryAgentStore, startAgentBackend } from "../dist/index.js";

const NETWORK = "Test SDF Network ; September 2015";

function sep53Sign(keypair, message) {
  return keypair.sign(Buffer.from(sep53Digest(Buffer.from(message, "utf8")))).toString("base64");
}

function testConfig() {
  return {
    bind: "127.0.0.1:0",
    databaseUrl: "sqlite://:memory:",
    networkPassphrase: NETWORK,
    corsOrigins: [],
    xmtp: { env: "dev", dbPath: "./unused" },
  };
}

async function startBackend(t, store = new MemoryAgentStore()) {
  const backend = await startAgentBackend({ config: testConfig(), store, startXmtp: false });
  t.after(() => backend.close());
  return backend;
}

/** MCP tool caller shaped like the old REST helper: {status, body}, with the typed error body's
 *  status surfacing failures so the old status-code assertions carry over 1:1. */
async function mcpCaller(t, backendUrl) {
  const client = new Client({ name: "agent-backend-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${backendUrl}/mcp`)));
  t.after(() => client.close().catch(() => {}));
  return async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content.find((c) => c.type === "text")?.text;
    const body = text ? JSON.parse(text) : undefined;
    if (res.isError) {
      assert.ok(body?.error?.status, `tool ${name} error result carries a typed body: ${text}`);
      return { status: body.error.status, body: body.error };
    }
    return { status: 200, body };
  };
}

test("mcp: full master → runner → agent → logs lifecycle", async (t) => {
  const store = new MemoryAgentStore();
  const backend = await startBackend(t, store);
  const call = await mcpCaller(t, backend.url);

  // info is open; health stays a REST carve-out.
  assert.equal((await call("info")).body.network_passphrase, NETWORK);
  assert.equal((await call("info")).body.xmtp_address, null);
  assert.deepEqual(await (await fetch(`${backend.url}/healthz`)).json(), { ok: true });

  // --- master auth (stellar) ---
  const masterKp = Keypair.random();
  const challenge = (await call("master_auth_challenge", { chain: "stellar", address: masterKp.publicKey() })).body;
  const verify = await call("master_auth_verify", {
    chain: "stellar",
    address: masterKp.publicKey(),
    challenge_id: challenge.challenge_id,
    signature: sep53Sign(masterKp, challenge.message),
  });
  assert.equal(verify.status, 200);
  const master = verify.body.token;

  // --- derive + register agent ---
  const root = await deriveAgentRoot(new Uint8Array(64).fill(7), {
    chain: "stellar",
    address: masterKp.publicKey(),
    networkPassphrase: NETWORK,
  });
  const identity = await root.deriveIdentity(0);
  const created = await call("register_agent", { session: master, descriptor: identity.descriptor("scout") });
  assert.equal(created.status, 200);
  const agentId = created.body.id;
  // Idempotent re-register.
  assert.equal((await call("register_agent", { session: master, descriptor: identity.descriptor("scout") })).body.id, agentId);
  // Wrong network is refused.
  const badNet = await call("register_agent", {
    session: master,
    descriptor: { ...identity.descriptor(), network_passphrase: "other" },
  });
  assert.equal(badNet.status, 400);
  // No/garbage session → 401 with the daemon's re-auth contract codes.
  const missing = await call("list_agents", {});
  assert.equal(missing.status, 401);
  assert.equal(missing.body.code, "AUTH_INVALID");
  const expired = await call("list_agents", { session: "no-such-token" });
  assert.equal(expired.status, 401);
  assert.equal(expired.body.code, "AUTH_EXPIRED");
  assert.equal((await call("list_agents", { session: master })).body.length, 1);

  // --- attached data + desired state ---
  const config = { version: 1, prompt: { custom: "trade well" }, provider: "openai", model: "gpt-5", peers: [] };
  assert.equal((await call("put_attached_data", { session: master, agent_id: agentId, key: "agent-config", value: config })).status, 200);
  assert.equal(
    (await call("set_desired_state", { session: master, agent_id: agentId, state: "running" })).body.desired_state,
    "running",
  );

  // --- runner: register, seal, auth, state ---
  const runnerSecret = generateRunnerSecret();
  const runnerKeys = await deriveRunnerKeys(runnerSecret);
  const runner = (
    await call("register_runner", {
      session: master,
      name: "laptop",
      auth_public_key: runnerKeys.authPublicKey,
      seal_public_key: toHex(runnerKeys.sealPublicKey),
    })
  ).body;
  const sealed = await sealAgentRoot(identity.root, runnerKeys.sealPublicKey, { agentId, runnerId: runner.id });
  assert.equal(
    (await call("put_sealed_root", { session: master, agent_id: agentId, runner_id: runner.id, envelope: sealed })).status,
    200,
  );

  const rc = (await call("runner_auth_challenge", { runner_id: runner.id })).body;
  const rv = await call("runner_auth_verify", {
    runner_id: runner.id,
    challenge_id: rc.challenge_id,
    signature: sep53Sign(runnerKeys.authKeypair, rc.message),
  });
  assert.equal(rv.status, 200);
  const runnerToken = rv.body.token;

  const state = (await call("runner_state", { session: runnerToken })).body;
  assert.equal(state.runner.id, runner.id);
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].agent.desired_state, "running");
  assert.equal(state.agents[0].config.model, "gpt-5");
  const unsealed = await openAgentRoot(state.agents[0].sealed_root, runnerKeys.sealSecretKey, { agentId, runnerId: runner.id });
  assert.equal(toHex(unsealed), toHex(identity.root));

  // Heartbeats + instance conflict.
  assert.deepEqual((await call("runner_heartbeat", { session: runnerToken, instance_id: "a" })).body, { ok: true });
  assert.equal((await call("runner_heartbeat", { session: runnerToken, instance_id: "b" })).body.conflict, true);
  // Master token on a runner tool → 403.
  assert.equal((await call("runner_state", { session: master })).status, 403);

  // --- agent session ---
  const ac = (await call("agent_auth_challenge", { stellar_public_key: identity.stellarPublicKey })).body;
  const av = await call("agent_auth_verify", {
    stellar_public_key: identity.stellarPublicKey,
    challenge_id: ac.challenge_id,
    signature: sep53Sign(identity.stellarKeypair, ac.message),
  });
  assert.equal(av.status, 200);
  const agentToken = av.body.token;
  const sessionId = av.body.session_id;
  assert.equal(av.body.attached["agent-config"].model, "gpt-5");

  assert.equal((await call("put_scratch", { session: agentToken, key: "state", value: { step: 1 } })).status, 200);
  const data = (await call("agent_data", { session: agentToken })).body;
  assert.deepEqual(data.scratch.state.value, { step: 1 });

  // --- logs: inject via the store (XMTP is off), read over MCP + the public REST feed ---
  await store.insertLogEntry({ session_id: sessionId, agent_id: agentId, seq: 1, at: 1, visibility: "public", kind: "session_start", payload: null });
  await store.insertLogEntry({ session_id: sessionId, agent_id: agentId, seq: 2, at: 2, visibility: "private", kind: "log", payload: { secret: true } });

  const pubRest = await (await fetch(`${backend.url}/v1/logs/public?session_id=${sessionId}`)).json();
  assert.equal(pubRest.entries.length, 1);
  assert.equal(pubRest.entries[0].visibility, "public");
  const pubTool = (await call("public_logs", { session_id: sessionId })).body.entries;
  assert.deepEqual(pubTool, pubRest.entries);

  const mine = (await call("master_logs", { session: master })).body.entries;
  assert.equal(mine.length, 2);
  assert.equal((await call("master_logs", {})).status, 401);

  const bySession = (await call("session_logs", { session: master, session_id: sessionId })).body.entries;
  assert.deepEqual(bySession.map((l) => l.seq), [1, 2]);
  assert.equal((await call("session_logs", { session: agentToken, session_id: sessionId })).body.entries.length, 2);
  assert.equal((await call("session_logs", { session: runnerToken, session_id: sessionId })).status, 403);

  // --- session end + revocation ---
  assert.equal((await call("end_agent_session", { session: agentToken })).status, 200);
  assert.ok((await call("agent_sessions", { session: master, agent_id: agentId })).body[0].ended_at > 0);

  const revoked = await call("revoke_agent", { session: master, agent_id: agentId });
  assert.equal(revoked.body.revoked, true);
  assert.equal((await call("agent_auth_challenge", { stellar_public_key: identity.stellarPublicKey })).status, 404);
  assert.equal((await call("revoke_runner", { session: master, runner_id: runner.id })).body.revoked, true);
  assert.equal((await call("runner_auth_challenge", { runner_id: runner.id })).status, 404);
});

test("mcp: ownership boundaries between two masters", async (t) => {
  const backend = await startBackend(t);
  const call = await mcpCaller(t, backend.url);

  async function masterToken(kp) {
    const c = (await call("master_auth_challenge", { chain: "stellar", address: kp.publicKey() })).body;
    return (
      await call("master_auth_verify", {
        chain: "stellar",
        address: kp.publicKey(),
        challenge_id: c.challenge_id,
        signature: sep53Sign(kp, c.message),
      })
    ).body.token;
  }

  const alice = Keypair.random();
  const mallory = Keypair.random();
  const aliceToken = await masterToken(alice);
  const malloryToken = await masterToken(mallory);

  const root = await deriveAgentRoot(new Uint8Array(64).fill(9), {
    chain: "stellar",
    address: alice.publicKey(),
    networkPassphrase: NETWORK,
  });
  const identity = await root.deriveIdentity(0);
  const agentId = (await call("register_agent", { session: aliceToken, descriptor: identity.descriptor() })).body.id;

  // Mallory cannot see, mutate, or register over Alice's agent.
  assert.equal((await call("get_agent", { session: malloryToken, agent_id: agentId })).status, 404);
  assert.equal((await call("revoke_agent", { session: malloryToken, agent_id: agentId })).status, 404);
  assert.equal(
    (await call("put_attached_data", { session: malloryToken, agent_id: agentId, key: "x", value: 1 })).status,
    404,
  );
  const stolen = await call("register_agent", { session: malloryToken, descriptor: identity.descriptor() });
  assert.equal(stolen.status, 403); // descriptor names Alice as master
  assert.equal((await call("list_agents", { session: malloryToken })).body.length, 0);
});

test("mcp: transport guards — initialize-first, body cap, CORS", async (t) => {
  const backend = await startBackend(t);

  // A tools/call without an mcp-session-id is refused before reaching any tool.
  const uninitialized = await fetch(`${backend.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "info", arguments: {} } }),
  });
  assert.equal(uninitialized.status, 400);
  assert.match((await uninitialized.json()).error.message, /initialize first/);

  // Body cap → 413 with the typed error body in the JSON-RPC envelope.
  process.env.MOSAIC_AGENT_MAX_BODY_BYTES = "512";
  const capped = await startAgentBackend({ config: testConfig(), store: new MemoryAgentStore(), startXmtp: false });
  delete process.env.MOSAIC_AGENT_MAX_BODY_BYTES;
  t.after(() => capped.close());
  const oversized = await fetch(`${capped.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { pad: "x".repeat(1024) } }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.data.code, "VALIDATION_FAILED");

  // Disallowed browser origin → 403 (loopback origins are dev-excepted, so use a public one).
  const cors = await fetch(`${backend.url}/healthz`, { headers: { origin: "https://evil.example" } });
  assert.equal(cors.status, 403);
});
