#!/usr/bin/env node
// mosaic-agent — the npx entrypoint:
//   OPENAI_API_KEY=... MOSAIC_IDENTITY=... npx @mosaic/agent-sdk start
// `start` runs the daemon/reconciler (re-exec'ing a pinned runtime version via npx first);
// `run-agent` is the internal child; `identity` prints the credential's public half.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AgentBackendClient } from "./backendClient.js";
import { runtimeVersionAction, startDaemon } from "./daemon.js";
import { fromHex, toHex } from "./bytes.js";
import { decodeRunnerIdentity, deriveRunnerKeys } from "./runner.js";
import { runAgent } from "./runtime/runtime.js";

const command = process.argv[2];

function fail(message: string): never {
  console.error(`mosaic-agent: ${message}`);
  process.exit(1);
}

function requireIdentity() {
  const raw = process.env.MOSAIC_IDENTITY;
  if (!raw) fail("MOSAIC_IDENTITY env var is required (create a runner on the Mosaic web app and copy the identity string)");
  try {
    return decodeRunnerIdentity(raw.trim());
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

async function start(): Promise<void> {
  const identity = requireIdentity();
  const keys = await deriveRunnerKeys(identity.secret);
  const client = new AgentBackendClient(identity.backend);
  await client.authenticateRunner(identity.id, keys.authKeypair);
  const state = await client.runnerState();
  await client.logout().catch(() => {});

  const action = runtimeVersionAction(
    packageVersion(),
    state.runner.runtime_version,
    Boolean(process.env.MOSAIC_RUNTIME_PINNED),
  );
  if (action.kind === "reexec") {
    console.log(`[daemon] runner pins runtime ${action.version} (this is ${packageVersion()}) — re-launching via npx`);
    const result = spawnSync("npx", ["-y", `@mosaic/agent-sdk@${action.version}`, "start"], {
      stdio: "inherit",
      env: { ...process.env, MOSAIC_RUNTIME_PINNED: "1" },
    });
    process.exit(result.status ?? 1);
  }

  const daemon = await startDaemon({
    identity,
    childEntry: fileURLToPath(import.meta.url),
  });
  console.log(`[daemon] running (instance ${daemon.instanceId}) — toggle agents on the web; Ctrl-C to stop`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`[daemon] ${signal} — stopping agents…`);
      void daemon.stop().then(() => process.exit(0));
    });
  }
}

async function runAgentChild(): Promise<void> {
  const rootHex = process.env.MOSAIC_AGENT_ROOT;
  const apiKey = process.env.MOSAIC_AGENT_API_KEY;
  const backendUrl = process.env.MOSAIC_AGENT_BACKEND;
  if (!rootHex || !apiKey || !backendUrl) {
    fail("run-agent needs MOSAIC_AGENT_ROOT, MOSAIC_AGENT_API_KEY, MOSAIC_AGENT_BACKEND (it is spawned by `start`)");
  }
  const result = await runAgent({
    agentRoot: fromHex(rootHex),
    apiKey,
    backendUrl,
    ...(process.env.MOSAIC_AGENT_DATA_DIR ? { dataDirBase: process.env.MOSAIC_AGENT_DATA_DIR } : {}),
  });
  process.exit(result.finishReason === "stop" ? 0 : 1);
}

async function identity(): Promise<void> {
  const decoded = requireIdentity();
  const keys = await deriveRunnerKeys(decoded.secret);
  console.log(
    JSON.stringify(
      {
        runner_id: decoded.id,
        backend: decoded.backend,
        auth_public_key: keys.authPublicKey,
        seal_public_key: toHex(keys.sealPublicKey),
      },
      null,
      2,
    ),
  );
}

switch (command) {
  case "start":
    void start().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
    break;
  case "run-agent":
    void runAgentChild().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
    break;
  case "identity":
    void identity().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
    break;
  default:
    console.log("usage: mosaic-agent <start|identity>\n  start     run the agent daemon (needs MOSAIC_IDENTITY + provider API key env)\n  identity  print the runner credential's public half");
    process.exit(command ? 1 : 0);
}
