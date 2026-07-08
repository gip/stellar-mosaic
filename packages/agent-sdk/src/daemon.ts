// The runner daemon behind `npx @mosaic/agent-sdk start`: authenticate with the runner credential,
// poll the backend's desired state, and reconcile — one `run-agent` child process per agent that
// should be running, stopped/started as the master toggles agents on the web. Decision logic
// (planReconcile, runtimeVersionAction) is pure and unit-tested; the loop owns processes only.

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { AgentBackendClient, AgentBackendClientError } from "./backendClient.js";
import { deriveRunnerKeys, openAgentRoot, type RunnerIdentity } from "./runner.js";
import { toHex } from "./bytes.js";
import { API_KEY_ENV } from "./runtime/llm.js";
import type { RunnerState } from "./types.js";

const TICK_MS = 15_000;
const KILL_GRACE_MS = 30_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;

export type VersionAction = { kind: "run" } | { kind: "reexec"; version: string };

/** Whether the daemon should re-exec a pinned runtime version via npx. `pinned` breaks the loop:
 *  the re-exec'd process runs whatever it is, no further hops. */
export function runtimeVersionAction(currentVersion: string, wantedVersion: string | undefined, pinned: boolean): VersionAction {
  if (pinned || !wantedVersion || wantedVersion === "latest" || wantedVersion === currentVersion) return { kind: "run" };
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(wantedVersion)) return { kind: "run" }; // unparseable pin: ignore
  return { kind: "reexec", version: wantedVersion };
}

export interface ReconcilePlan {
  /** Agent ids to start (they have everything needed to run). */
  start: string[];
  /** Agent ids to stop. */
  stop: string[];
  /** Agents that should run but cannot, with the reason (warn, do not crash-loop). */
  skipped: { id: string; reason: string }[];
}

export function planReconcile(
  state: RunnerState,
  running: Iterable<string>,
  env: NodeJS.ProcessEnv,
  backoffUntil: Map<string, number>,
  now: number,
): ReconcilePlan {
  const runningSet = new Set(running);
  const plan: ReconcilePlan = { start: [], stop: [], skipped: [] };
  const shouldRun = new Set<string>();

  for (const { agent, config, sealed_root } of state.agents) {
    if (agent.revoked || agent.desired_state !== "running") continue;
    if (!sealed_root) {
      plan.skipped.push({ id: agent.id, reason: "no sealed key bundle for this runner (re-seal on the web)" });
      continue;
    }
    if (!config) {
      plan.skipped.push({ id: agent.id, reason: "no agent-config (configure the agent on the web)" });
      continue;
    }
    const keyEnv = API_KEY_ENV[config.provider];
    if (!keyEnv || !env[keyEnv]) {
      plan.skipped.push({ id: agent.id, reason: `${keyEnv ?? "provider"} is not set in the daemon environment` });
      continue;
    }
    shouldRun.add(agent.id);
    if (runningSet.has(agent.id)) continue;
    const until = backoffUntil.get(agent.id) ?? 0;
    if (until > now) {
      plan.skipped.push({ id: agent.id, reason: `crash backoff (${Math.ceil((until - now) / 1000)}s left)` });
      continue;
    }
    plan.start.push(agent.id);
  }

  for (const id of runningSet) if (!shouldRun.has(id)) plan.stop.push(id);
  return plan;
}

export interface DaemonOptions {
  identity: RunnerIdentity;
  /** Path to the built cli entry (dist/cli.js) used to spawn `run-agent` children. */
  childEntry: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Poll interval override (tests). */
  tickMs?: number;
}

export interface DaemonHandle {
  instanceId: string;
  /** Agent ids currently running. */
  running(): string[];
  stop(): Promise<void>;
}

interface Child {
  proc: ChildProcess;
  stopping: boolean;
}

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(`[daemon] ${line}`));
  const keys = await deriveRunnerKeys(opts.identity.secret);
  const client = new AgentBackendClient(opts.identity.backend);
  await client.authenticateRunner(opts.identity.id, keys.authKeypair);
  log(`authenticated as runner ${opts.identity.id} against ${opts.identity.backend}`);

  const instanceId = randomUUID();
  const children = new Map<string, Child>();
  const crashes = new Map<string, { count: number; until: number }>();
  const warned = new Set<string>();
  let stopped = false;

  const spawnAgent = (agentId: string, state: RunnerState): void => {
    const entry = state.agents.find((a) => a.agent.id === agentId);
    if (!entry?.sealed_root || !entry.config) return;
    void openAgentRoot(entry.sealed_root, keys.sealSecretKey, { agentId, runnerId: opts.identity.id })
      .then((root) => {
        if (stopped || children.has(agentId)) return;
        const apiKey = env[API_KEY_ENV[entry.config!.provider]]!;
        const name = entry.agent.name ?? agentId.slice(0, 8);
        const proc = spawn(process.execPath, [opts.childEntry, "run-agent"], {
          env: {
            ...env,
            MOSAIC_AGENT_ROOT: toHex(root),
            MOSAIC_AGENT_API_KEY: apiKey,
            MOSAIC_AGENT_BACKEND: opts.identity.backend,
          },
          stdio: ["ignore", "inherit", "inherit"],
        });
        children.set(agentId, { proc, stopping: false });
        log(`started agent "${name}" (${agentId}, pid ${proc.pid})`);
        proc.once("exit", (code, signal) => {
          const child = children.get(agentId);
          children.delete(agentId);
          if (stopped || child?.stopping) return;
          const crash = crashes.get(agentId) ?? { count: 0, until: 0 };
          if (code === 0) {
            crashes.delete(agentId);
            log(`agent "${name}" finished cleanly — it stays desired=running; it will restart next tick`);
            // A cleanly finished agent restarting forever is rarely wanted; back off like a crash
            // so a "run once" mandate doesn't loop hot. The master stops it on the web when done.
            crashes.set(agentId, { count: crash.count + 1, until: Date.now() + backoffMs(crash.count) });
          } else {
            crashes.set(agentId, { count: crash.count + 1, until: Date.now() + backoffMs(crash.count) });
            log(`agent "${name}" exited (code ${code}, signal ${signal}) — backing off ${backoffMs(crash.count) / 1000}s`);
          }
        });
      })
      .catch((error: unknown) => {
        crashes.set(agentId, { count: 99, until: Date.now() + BACKOFF_MAX_MS });
        log(`cannot unseal agent ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const stopAgent = (agentId: string): void => {
    const child = children.get(agentId);
    if (!child || child.stopping) return;
    child.stopping = true;
    log(`stopping agent ${agentId} (pid ${child.proc.pid})`);
    child.proc.kill("SIGTERM");
    const hardKill = setTimeout(() => child.proc.kill("SIGKILL"), KILL_GRACE_MS);
    hardKill.unref?.();
    child.proc.once("exit", () => clearTimeout(hardKill));
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let state: RunnerState;
    try {
      const beat = await client.heartbeat(instanceId);
      if (beat.conflict) {
        log("another live daemon holds this runner credential — exiting to avoid double-running agents");
        await stop();
        process.exitCode = 2;
        return;
      }
      state = await client.runnerState();
    } catch (error) {
      if (error instanceof AgentBackendClientError && error.status === 401) {
        log("session expired — re-authenticating");
        await client.authenticateRunner(opts.identity.id, keys.authKeypair).catch((e: unknown) => {
          log(`re-auth failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      } else {
        log(`state fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    const backoffUntil = new Map([...crashes].map(([id, c]) => [id, c.until]));
    const plan = planReconcile(state, children.keys(), env, backoffUntil, Date.now());
    for (const { id, reason } of plan.skipped) {
      const key = `${id}:${reason}`;
      if (!warned.has(key)) {
        warned.add(key);
        log(`agent ${id} not started: ${reason}`);
      }
    }
    for (const id of plan.stop) stopAgent(id);
    for (const id of plan.start) spawnAgent(id, state);
  };

  const interval = setInterval(() => void tick(), opts.tickMs ?? TICK_MS);
  void tick();

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    for (const id of [...children.keys()]) stopAgent(id);
    // Give children the grace window to flush session_end before we return.
    const deadline = Date.now() + KILL_GRACE_MS + 1000;
    while (children.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  };

  return { instanceId, running: () => [...children.keys()], stop };
}

function backoffMs(priorCrashes: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** priorCrashes, BACKOFF_MAX_MS);
}
