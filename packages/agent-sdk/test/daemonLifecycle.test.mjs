// startDaemon against an in-process backend with a stub child entry: runner auth, reconcile-spawn
// (with a real sealed root the daemon must unseal), web-toggled stop, and shutdown.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryAgentStore, startAgentBackend } from "@mosaic/agent-backend";
import {
  deriveAgentRoot,
  deriveRunnerKeys,
  generateRunnerSecret,
  sealAgentRoot,
  startDaemon,
  toHex,
} from "../dist/index.js";

const NETWORK = "Test SDF Network ; September 2015";

async function until(cond, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("daemon: spawns a desired agent, stops it when toggled off, shuts down", async (t) => {
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

  // A stub child that records its env and stays alive until SIGTERM.
  const dir = mkdtempSync(join(tmpdir(), "mosaic-daemon-"));
  const envFile = join(dir, "child-env.json");
  const childEntry = join(dir, "stub-child.mjs");
  writeFileSync(
    childEntry,
    `import { writeFileSync } from "node:fs";
if (process.argv[2] !== "run-agent") process.exit(9);
writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({
  root: process.env.MOSAIC_AGENT_ROOT,
  apiKey: process.env.MOSAIC_AGENT_API_KEY,
  backend: process.env.MOSAIC_AGENT_BACKEND,
}));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
  );

  // Master-side setup, directly on the store: agent + runner + sealed root + config + running.
  const masterId = "stellar:GMASTER";
  const root = await deriveAgentRoot(new Uint8Array(64).fill(3), {
    chain: "stellar",
    address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    networkPassphrase: NETWORK,
  });
  const identity = await root.deriveIdentity(0);
  const agent = await store.registerAgent(masterId, identity.descriptor("worker"));
  const runnerSecret = generateRunnerSecret();
  const runnerKeys = await deriveRunnerKeys(runnerSecret);
  const runner = await store.registerRunner(masterId, {
    auth_public_key: runnerKeys.authPublicKey,
    seal_public_key: toHex(runnerKeys.sealPublicKey),
  });
  await store.putSealedRoot(
    masterId,
    agent.id,
    runner.id,
    await sealAgentRoot(identity.root, runnerKeys.sealPublicKey, { agentId: agent.id, runnerId: runner.id }),
  );
  await store.putAgentData(
    agent.id,
    "attached",
    "agent-config",
    { version: 1, provider: "openai", model: "gpt-5", prompt: { preset: "buyer" } },
    masterId,
  );
  await store.setDesiredState(masterId, agent.id, "running");

  const lines = [];
  const daemon = await startDaemon({
    identity: { v: 1, backend: backend.url, id: runner.id, secret: runnerSecret },
    childEntry,
    env: { ...process.env, OPENAI_API_KEY: "sk-test" },
    tickMs: 200,
    log: (l) => lines.push(l),
  });
  t.after(() => daemon.stop());

  // The child comes up with the unsealed root + key + backend url in env.
  assert.ok(await until(() => daemon.running().includes(agent.id)), `agent never started; log:\n${lines.join("\n")}`);
  assert.ok(await until(() => existsSync(envFile)));
  const childEnv = JSON.parse(readFileSync(envFile, "utf8"));
  assert.equal(childEnv.root, toHex(identity.root));
  assert.equal(childEnv.apiKey, "sk-test");
  assert.equal(childEnv.backend, backend.url);

  // Web toggle → the daemon stops the child on a later tick.
  await store.setDesiredState(masterId, agent.id, "stopped");
  assert.ok(await until(() => daemon.running().length === 0), `agent never stopped; log:\n${lines.join("\n")}`);

  await daemon.stop();
});
