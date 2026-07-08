// End-to-end integration without network or LLM: in-process agent-backend (memory store, XMTP
// off) driven purely through the SDK — master auth, derive + register, runner credential + sealed
// root, agent-config + desired state, runner state fetch + unseal, agent session with an injected
// logger that pipes envelopes into the store the way the XMTP inbox would.

import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { SecretKeySigner } from "@mosaic/sdk";
import { MemoryAgentStore, startAgentBackend } from "@mosaic/agent-backend";
import {
  AgentBackendClient,
  deriveAgentRoot,
  deriveRunnerKeys,
  generateRunnerSecret,
  encodeRunnerIdentity,
  decodeRunnerIdentity,
  agentIdentityFromRoot,
  sealAgentRoot,
  openAgentRoot,
  sealAgentData,
  signAgentMasterStellar,
  startAgentSession,
  toHex,
} from "../dist/index.js";

const NETWORK = "Test SDF Network ; September 2015";

test("full lifecycle through the SDK", async (t) => {
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

  // --- master: sign once, derive, authenticate, register -------------------
  const masterKp = Keypair.random();
  const signer = new SecretKeySigner(masterKp.secret());
  const { ref, signature } = await signAgentMasterStellar(signer, NETWORK);
  const root = await deriveAgentRoot(signature, ref);
  const identity = await root.deriveIdentity(0);

  const masterClient = new AgentBackendClient(backend.url);
  const { master_id } = await masterClient.authenticateMasterStellar(signer);
  assert.equal(master_id, `stellar:${masterKp.publicKey()}`);

  const agent = await masterClient.registerAgent(identity.descriptor("scout"));

  // Attached config (plain) + a sealed secret only the agent can open.
  await masterClient.putAgentConfig(agent.id, {
    version: 1,
    prompt: { custom: "make spreads" },
    provider: "openai",
    model: "gpt-5",
    peers: [],
  });
  const sealedSecret = await sealAgentData({ apiHint: "hunter2" }, identity.dataKey);
  await masterClient.putAttached(agent.id, "secret-note", sealedSecret);
  await masterClient.setDesiredState(agent.id, "running");

  // --- runner credential: register, seal, roundtrip through MOSAIC_IDENTITY ---
  const runnerSecret = generateRunnerSecret();
  const runnerKeys = await deriveRunnerKeys(runnerSecret);
  const runner = await masterClient.registerRunner({
    name: "laptop",
    auth_public_key: runnerKeys.authPublicKey,
    seal_public_key: toHex(runnerKeys.sealPublicKey),
  });
  await masterClient.putSealedRoot(
    agent.id,
    runner.id,
    await sealAgentRoot(identity.root, runnerKeys.sealPublicKey, { agentId: agent.id, runnerId: runner.id }),
  );

  const mosaicIdentity = encodeRunnerIdentity({ backend: backend.url, id: runner.id, secret: runnerSecret });

  // --- daemon side: decode, authenticate, fetch state, unseal, rebuild identity ---
  const decoded = decodeRunnerIdentity(mosaicIdentity);
  const daemonKeys = await deriveRunnerKeys(decoded.secret);
  const runnerClient = new AgentBackendClient(decoded.backend);
  await runnerClient.authenticateRunner(decoded.id, daemonKeys.authKeypair);
  const state = await runnerClient.runnerState();
  assert.equal(state.agents.length, 1);
  const entry = state.agents[0];
  assert.equal(entry.agent.desired_state, "running");
  assert.equal(entry.config.model, "gpt-5");
  const agentRoot = await openAgentRoot(entry.sealed_root, daemonKeys.sealSecretKey, {
    agentId: entry.agent.id,
    runnerId: decoded.id,
  });
  const childIdentity = await agentIdentityFromRoot(agentRoot);
  assert.equal(childIdentity.stellarPublicKey, identity.stellarPublicKey);
  assert.equal((await runnerClient.heartbeat("daemon-1")).ok, true);

  // --- agent session: injected logger emulating the XMTP inbox -------------
  const delivered = [];
  const session = await startAgentSession({
    backendUrl: backend.url,
    identity: childIdentity,
    createLogger: async () => ({
      async log(envelope) {
        delivered.push(envelope);
        // Emulate what the inbox worker does after validating the sender.
        await store.insertLogEntry({
          session_id: envelope.session_id,
          agent_id: entry.agent.id,
          seq: envelope.seq,
          at: envelope.at,
          visibility: envelope.visibility,
          kind: envelope.kind,
          payload: envelope.payload,
        });
      },
      async close() {},
    }),
  });

  // Sealed attached data opens with the derived dataKey; plain config comes through as-is.
  assert.deepEqual(await session.openAttached("secret-note"), { apiHint: "hunter2" });
  assert.equal((await session.openAttached("agent-config")).model, "gpt-5");

  await session.putScratch("progress", { fills: 2 });
  const refreshed = await session.refreshData();
  assert.deepEqual(refreshed.scratch.progress, { fills: 2 });

  await session.log({ msg: "posted order" }, { visibility: "public" });
  await session.log({ msg: "internal reasoning" }); // private by default
  await session.end();
  await session.end(); // idempotent

  // Envelope stream: session_start(1), log(2), log(3), session_end(4), seq strictly ordered.
  assert.deepEqual(delivered.map((e) => [e.seq, e.kind]), [
    [1, "session_start"],
    [2, "log"],
    [3, "log"],
    [4, "session_end"],
  ]);

  // --- reads: public feed is unauthenticated; master sees everything -------
  const publicClient = new AgentBackendClient(backend.url);
  const pub = await publicClient.publicLogs({ session_id: session.sessionId });
  assert.equal(pub.length, 1);
  assert.deepEqual(pub[0].payload, { msg: "posted order" });

  const all = await masterClient.logs({ session_id: session.sessionId });
  assert.equal(all.length, 4);
  const sessions = await masterClient.agentSessions(agent.id);
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0].ended_at > 0);
  assert.equal(sessions[0].log_count, 4);

  // --- revocation cuts the runner off ---------------------------------------
  await masterClient.revokeRunner(runner.id);
  await assert.rejects(runnerClient.runnerState(), /not found/);
});
