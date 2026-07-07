// Full REST surface over fetch against an in-process server (memory store, XMTP off, port 0).
// Exercises the three auth scopes end to end with real signatures, ownership boundaries, and the
// unauthenticated public-log feed.

import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Keypair } from "@stellar/stellar-sdk";
import { sep53Digest } from "@mosaic/sdk";
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

async function json(res) {
  const body = await res.json();
  return { status: res.status, body };
}

function api(baseUrl) {
  return async (method, path, { body, token } = {}) =>
    json(
      await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
}

test("http: full master → runner → agent → logs lifecycle", async (t) => {
  const store = new MemoryAgentStore();
  const backend = await startAgentBackend({
    config: {
      bind: "127.0.0.1:0",
      databaseUrl: "sqlite://:memory:",
      networkPassphrase: NETWORK,
      corsOrigins: [],
      xmtp: { env: "dev", dbPath: "./unused" },
    },
    store,
    startXmtp: false,
  });
  t.after(() => backend.close());
  const call = api(backend.url);

  // info + health are open.
  assert.equal((await call("GET", "/v1/info")).body.network_passphrase, NETWORK);
  assert.equal((await call("GET", "/v1/info")).body.xmtp_address, null);

  // --- master auth (stellar) ---
  const masterKp = Keypair.random();
  const challenge = (await call("POST", "/v1/auth/challenge", { body: { chain: "stellar", address: masterKp.publicKey() } })).body;
  const verify = await call("POST", "/v1/auth/verify", {
    body: {
      chain: "stellar",
      address: masterKp.publicKey(),
      challenge_id: challenge.challenge_id,
      signature: sep53Sign(masterKp, challenge.message),
    },
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
  const created = await call("POST", "/v1/agents", { body: identity.descriptor("scout"), token: master });
  assert.equal(created.status, 201);
  const agentId = created.body.id;
  // Idempotent re-register.
  assert.equal((await call("POST", "/v1/agents", { body: identity.descriptor("scout"), token: master })).body.id, agentId);
  // Wrong network is refused.
  const badNet = await call("POST", "/v1/agents", {
    body: { ...identity.descriptor(), network_passphrase: "other" },
    token: master,
  });
  assert.equal(badNet.status, 400);
  // No token → 401.
  assert.equal((await call("GET", "/v1/agents")).status, 401);
  assert.equal((await call("GET", "/v1/agents", { token: master })).body.length, 1);

  // --- attached data + desired state ---
  const config = { version: 1, prompt: { custom: "trade well" }, provider: "openai", model: "gpt-5", peers: [] };
  assert.equal((await call("PUT", `/v1/agents/${agentId}/data/agent-config`, { body: { value: config }, token: master })).status, 200);
  assert.equal(
    (await call("PUT", `/v1/agents/${agentId}/desired-state`, { body: { state: "running" }, token: master })).body.desired_state,
    "running",
  );

  // --- runner: register, seal, auth, state ---
  const runnerSecret = generateRunnerSecret();
  const runnerKeys = await deriveRunnerKeys(runnerSecret);
  const runner = (
    await call("POST", "/v1/runners", {
      body: { name: "laptop", auth_public_key: runnerKeys.authPublicKey, seal_public_key: toHex(runnerKeys.sealPublicKey) },
      token: master,
    })
  ).body;
  const sealed = await sealAgentRoot(identity.root, runnerKeys.sealPublicKey, { agentId, runnerId: runner.id });
  assert.equal((await call("PUT", `/v1/agents/${agentId}/sealed-keys/${runner.id}`, { body: sealed, token: master })).status, 200);

  const rc = (await call("POST", "/v1/runner/auth/challenge", { body: { runner_id: runner.id } })).body;
  const rv = await call("POST", "/v1/runner/auth/verify", {
    body: { runner_id: runner.id, challenge_id: rc.challenge_id, signature: sep53Sign(runnerKeys.authKeypair, rc.message) },
  });
  assert.equal(rv.status, 200);
  const runnerToken = rv.body.token;

  const state = (await call("GET", "/v1/runner/state", { token: runnerToken })).body;
  assert.equal(state.runner.id, runner.id);
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].agent.desired_state, "running");
  assert.equal(state.agents[0].config.model, "gpt-5");
  const unsealed = await openAgentRoot(state.agents[0].sealed_root, runnerKeys.sealSecretKey, { agentId, runnerId: runner.id });
  assert.equal(toHex(unsealed), toHex(identity.root));

  // Heartbeats + instance conflict.
  assert.deepEqual((await call("POST", "/v1/runner/heartbeat", { body: { instance_id: "a" }, token: runnerToken })).body, { ok: true });
  assert.equal((await call("POST", "/v1/runner/heartbeat", { body: { instance_id: "b" }, token: runnerToken })).body.conflict, true);
  // Master token on a runner route → 403.
  assert.equal((await call("GET", "/v1/runner/state", { token: master })).status, 403);

  // --- agent session ---
  const ac = (await call("POST", "/v1/agent/auth/challenge", { body: { stellar_public_key: identity.stellarPublicKey } })).body;
  const av = await call("POST", "/v1/agent/auth/verify", {
    body: {
      stellar_public_key: identity.stellarPublicKey,
      challenge_id: ac.challenge_id,
      signature: sep53Sign(identity.stellarKeypair, ac.message),
    },
  });
  assert.equal(av.status, 200);
  const agentToken = av.body.token;
  const sessionId = av.body.session_id;
  assert.equal(av.body.attached["agent-config"].model, "gpt-5");

  assert.equal((await call("PUT", "/v1/agent/scratch/state", { body: { value: { step: 1 } }, token: agentToken })).status, 200);
  const data = (await call("GET", "/v1/agent/data", { token: agentToken })).body;
  assert.deepEqual(data.scratch.state.value, { step: 1 });

  // --- logs: inject via the store (XMTP is off), read over HTTP ---
  await store.insertLogEntry({ session_id: sessionId, agent_id: agentId, seq: 1, at: 1, visibility: "public", kind: "session_start", payload: null });
  await store.insertLogEntry({ session_id: sessionId, agent_id: agentId, seq: 2, at: 2, visibility: "private", kind: "log", payload: { secret: true } });

  const pub = (await call("GET", `/v1/logs/public?session_id=${sessionId}`)).body.entries;
  assert.equal(pub.length, 1);
  assert.equal(pub[0].visibility, "public");

  const mine = (await call("GET", "/v1/logs", { token: master })).body.entries;
  assert.equal(mine.length, 2);
  assert.equal((await call("GET", "/v1/logs")).status, 401);

  const bySession = (await call("GET", `/v1/sessions/${sessionId}/logs`, { token: master })).body.entries;
  assert.deepEqual(bySession.map((l) => l.seq), [1, 2]);
  assert.equal((await call("GET", `/v1/sessions/${sessionId}/logs`, { token: agentToken })).body.entries.length, 2);
  assert.equal((await call("GET", `/v1/sessions/${sessionId}/logs`, { token: runnerToken })).status, 403);

  // --- session end + revocation ---
  assert.equal((await call("POST", "/v1/agent/session/end", { token: agentToken })).status, 200);
  assert.ok((await call("GET", `/v1/agents/${agentId}/sessions`, { token: master })).body[0].ended_at > 0);

  const revoked = await call("DELETE", `/v1/agents/${agentId}`, { token: master });
  assert.equal(revoked.body.revoked, true);
  assert.equal((await call("POST", "/v1/agent/auth/challenge", { body: { stellar_public_key: identity.stellarPublicKey } })).status, 404);
  assert.equal((await call("DELETE", `/v1/runners/${runner.id}`, { token: master })).body.revoked, true);
  assert.equal((await call("POST", "/v1/runner/auth/challenge", { body: { runner_id: runner.id } })).status, 404);
});

test("http: ownership boundaries between two masters", async (t) => {
  const backend = await startAgentBackend({
    config: {
      bind: "127.0.0.1:0",
      databaseUrl: "sqlite://:memory:",
      networkPassphrase: NETWORK,
      corsOrigins: [],
      xmtp: { env: "dev", dbPath: "./unused" },
    },
    store: new MemoryAgentStore(),
    startXmtp: false,
  });
  t.after(() => backend.close());
  const call = api(backend.url);

  async function masterToken(kp) {
    const c = (await call("POST", "/v1/auth/challenge", { body: { chain: "stellar", address: kp.publicKey() } })).body;
    return (
      await call("POST", "/v1/auth/verify", {
        body: { chain: "stellar", address: kp.publicKey(), challenge_id: c.challenge_id, signature: sep53Sign(kp, c.message) },
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
  const agentId = (await call("POST", "/v1/agents", { body: identity.descriptor(), token: aliceToken })).body.id;

  // Mallory cannot see, mutate, or register over Alice's agent.
  assert.equal((await call("GET", `/v1/agents/${agentId}`, { token: malloryToken })).status, 404);
  assert.equal((await call("DELETE", `/v1/agents/${agentId}`, { token: malloryToken })).status, 404);
  assert.equal(
    (await call("PUT", `/v1/agents/${agentId}/data/x`, { body: { value: 1 }, token: malloryToken })).status,
    404,
  );
  const stolen = await call("POST", "/v1/agents", { body: identity.descriptor(), token: malloryToken });
  assert.equal(stolen.status, 403); // descriptor names Alice as master
  assert.equal((await call("GET", "/v1/agents", { token: malloryToken })).body.length, 0);
});
