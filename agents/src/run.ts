// Experiment orchestrator: node dist/run.js <experiment.yaml|json> [--check] [--skip-llm-check]
//
// Loads + validates the experiment config, provisions whatever identities the config omits
// (preflight fails fast), spawns one child process per agent with prefixed output, then
// independently verdicts the run from Horizon balance deltas — nothing the agents report is
// trusted. Every run writes results/<experiment>-<runId>.json; all mutable state (note DBs, XMTP
// DBs, transcripts, identities) lives in .experiments/<experiment>/<runId>/.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Horizon } from "@stellar/stellar-sdk";
import { loadExperiment, type ExperimentConfig, type ResolvedAgentFile, type VerdictRule } from "./experiment.js";
import { provision, type Provisioned } from "./provision.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Balances {
  xlm: number;
  usdc: number;
}

async function balances(horizon: Horizon.Server, address: string, usdcIssuer: string): Promise<Balances> {
  const account = await horizon.loadAccount(address);
  let xlm = 0;
  let usdc = 0;
  for (const b of account.balances) {
    const line = b as { asset_code?: string; asset_issuer?: string };
    if (b.asset_type === "native") xlm = Number(b.balance);
    // Only the per-run demo USDC counts — a pre-existing USDC line from another issuer must not
    // leak into the deltas the verdict is computed from.
    else if (line.asset_code === "USDC" && line.asset_issuer === usdcIssuer) usdc = Number(b.balance);
  }
  return { xlm, usdc };
}

interface AgentHandle {
  /** Resolves to the exit code (null if killed by signal). */
  exited: Promise<number | null>;
  /** SIGTERM (the agent flushes its transcript), escalating to SIGKILL after 10s. */
  kill: () => void;
}

function runAgent(name: string, agentFile: string, appendLog: (line: string) => void): AgentHandle {
  const child = spawn(process.execPath, [join(PACKAGE_ROOT, "dist/agentMain.js")], {
    env: { ...process.env, AGENT_FILE: agentFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Agent stdout is already [name]-prefixed; prefix stderr (stack traces, SDK noise) ourselves.
  createInterface({ input: child.stdout }).on("line", (l) => {
    console.log(l);
    appendLog(l);
  });
  createInterface({ input: child.stderr }).on("line", (l) => {
    console.error(`[${name}!] ${l}`);
    appendLog(`[${name}!] ${l}`);
  });
  const exited = new Promise<number | null>((resolvePromise) => {
    child.on("exit", (code) => resolvePromise(code));
  });
  return {
    exited,
    kill: () => {
      child.kill("SIGTERM");
      const escalate = setTimeout(() => child.kill("SIGKILL"), 10_000);
      escalate.unref();
      void exited.then(() => clearTimeout(escalate));
    },
  };
}

function evaluateVerdict(
  rules: VerdictRule[],
  deltas: Record<string, Balances>,
): { rules: Array<VerdictRule & { delta: number; pass: boolean }>; pass: boolean } {
  const evaluated = rules.map((rule) => {
    const delta = rule.asset === "XLM" ? deltas[rule.agent].xlm : deltas[rule.agent].usdc;
    const pass =
      (rule.min === undefined || delta >= Number(rule.min)) &&
      (rule.max === undefined || delta <= Number(rule.max));
    return { ...rule, delta, pass };
  });
  return { rules: evaluated, pass: evaluated.every((r) => r.pass) };
}

function writeAgentFiles(cfg: ExperimentConfig, provisioned: Provisioned, runDir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const agent of provisioned.agents) {
    const resolved: ResolvedAgentFile = {
      experiment: cfg.name,
      name: agent.name,
      provider: agent.provider,
      apiKey: agent.apiKey,
      model: agent.model,
      prompt: agent.prompt,
      webSearch: agent.webSearch,
      maxTurns: cfg.maxTurns,
      stellarSecret: agent.stellarSecret,
      stellarAddress: agent.stellarAddress,
      ethKey: agent.ethKey,
      ethAddress: agent.ethAddress,
      xmtpDbKey: agent.xmtpDbKey,
      peers: provisioned.agents
        .filter((p) => p.name !== agent.name)
        .map((p) => ({ name: p.name, ethAddress: p.ethAddress })),
      usdcIssuer: provisioned.usdc.issuer,
      network: {
        rpcUrl: cfg.network.rpcUrl,
        networkPassphrase: cfg.network.networkPassphrase,
        friendbotUrl: cfg.network.friendbotUrl,
      },
      horizonUrl: cfg.network.horizonUrl,
      runDir,
    };
    const path = join(runDir, `${agent.name}.agent.json`);
    writeFileSync(path, JSON.stringify(resolved, null, 2) + "\n", { mode: 0o600 });
    files.set(agent.name, path);
  }
  return files;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const skipLlmCheck = args.includes("--skip-llm-check");
  const configPath = args.find((a) => !a.startsWith("--"));
  if (!configPath) {
    console.error("usage: node dist/run.js <experiment.yaml|json> [--check] [--skip-llm-check]");
    process.exit(2);
  }
  const cfg = loadExperiment(resolve(configPath));
  const horizon = new Horizon.Server(cfg.network.horizonUrl);

  const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const runDir = join(PACKAGE_ROOT, ".experiments", cfg.name, runId);
  mkdirSync(runDir, { recursive: true });
  console.log(`experiment "${cfg.name}" · ${cfg.agents.length} agents · run ${runId}`);
  console.log(`run dir ${runDir}`);

  console.log("--- preflight ---");
  const provisioned = await provision(cfg, { log: console.log, checkLlm: !skipLlmCheck });
  // Secrets (incl. generated ones — needed to reclaim testnet funds) stay in the run dir, 0600.
  writeFileSync(
    join(runDir, "identities.json"),
    JSON.stringify(
      {
        usdc: provisioned.usdc,
        agents: provisioned.agents.map(({ apiKey: _apiKey, ...rest }) => rest),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  if (checkOnly) {
    console.log(`--- preflight OK · identities in ${runDir}/identities.json ---`);
    process.exit(0);
  }

  const agentFiles = writeAgentFiles(cfg, provisioned, runDir);

  const before: Record<string, Balances> = {};
  for (const a of provisioned.agents) {
    before[a.name] = await balances(horizon, a.stellarAddress, provisioned.usdc.issuer);
    console.log(`${a.name.padEnd(8)} ${a.stellarAddress}  XLM ${before[a.name].xlm}  USDC ${before[a.name].usdc}`);
  }

  console.log(`--- launching agents (wall-clock cap ${cfg.timeoutMinutes} min) ---`);
  const logPath = join(runDir, "run.log");
  const appendLog = (line: string) => writeFileSync(logPath, line + "\n", { flag: "a" });
  const started = Date.now();
  const handles = provisioned.agents.map((a) => runAgent(a.name, agentFiles.get(a.name)!, appendLog));
  const finished = new Set<number>();
  handles.forEach((h, i) => void h.exited.then(() => finished.add(i)));
  const timedOutAgents: string[] = [];
  const timer = setTimeout(() => {
    for (let i = 0; i < handles.length; i++) {
      if (!finished.has(i)) {
        timedOutAgents.push(provisioned.agents[i].name);
        handles[i].kill();
      }
    }
    const line = `--- run timeout after ${cfg.timeoutMinutes} min — killing ${timedOutAgents.join(", ")} ---`;
    console.error(line);
    appendLog(line);
  }, cfg.timeoutMinutes * 60_000);
  const exitCodes = await Promise.all(handles.map((h) => h.exited));
  clearTimeout(timer);
  const durationSeconds = Math.round((Date.now() - started) / 1000);
  console.log(
    `--- agents finished in ${durationSeconds}s (${provisioned.agents.map((a, i) => `${a.name} exit ${exitCodes[i] ?? "killed"}`).join(", ")}) ---`,
  );

  const after: Record<string, Balances> = {};
  const deltas: Record<string, Balances> = {};
  for (const a of provisioned.agents) {
    after[a.name] = await balances(horizon, a.stellarAddress, provisioned.usdc.issuer);
    deltas[a.name] = {
      xlm: after[a.name].xlm - before[a.name].xlm,
      usdc: after[a.name].usdc - before[a.name].usdc,
    };
    console.log(`${a.name.padEnd(8)} Δ  XLM ${deltas[a.name].xlm.toFixed(7)}  USDC ${deltas[a.name].usdc.toFixed(7)}`);
  }

  const timedOut = timedOutAgents.length > 0;
  const allExitedClean = exitCodes.every((c) => c === 0) && !timedOut;
  const verdict = evaluateVerdict(cfg.verdict, deltas);
  const pass = verdict.pass && allExitedClean;
  if (timedOut) console.log(`verdict ✗ timed out: ${timedOutAgents.join(", ")}`);
  for (const r of verdict.rules) {
    console.log(
      `verdict ${r.pass ? "✓" : "✗"} ${r.agent} ${r.asset} Δ ${r.delta.toFixed(7)} (min ${r.min ?? "—"}, max ${r.max ?? "—"})`,
    );
  }
  if (cfg.verdict.length === 0) console.log("verdict · no rules configured — reporting deltas only");
  console.log(pass ? "PASS ✅" : "FAIL ❌");

  // Per-agent outcome from the transcripts the children wrote (usage, finish reason).
  interface TokenUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  }
  const agentOutcomes = provisioned.agents.map((a, i) => {
    const transcriptPath = join(runDir, `${a.name}.transcript.json`);
    let finishReason: string | undefined;
    let totalUsage: TokenUsage | undefined;
    let steps: number | undefined;
    if (existsSync(transcriptPath)) {
      const t = JSON.parse(readFileSync(transcriptPath, "utf8")) as {
        finishReason?: string;
        totalUsage?: TokenUsage;
        steps?: unknown[];
      };
      finishReason = t.finishReason;
      totalUsage = t.totalUsage;
      steps = t.steps?.length;
    }
    return {
      name: a.name,
      provider: a.provider,
      model: a.model,
      stellarAddress: a.stellarAddress,
      ethAddress: a.ethAddress,
      stellarGenerated: a.stellarGenerated,
      ethGenerated: a.ethGenerated,
      exitCode: exitCodes[i],
      timedOut: timedOutAgents.includes(a.name),
      finishReason,
      steps,
      totalUsage,
      transcript: existsSync(transcriptPath) ? transcriptPath : undefined,
    };
  });

  console.log("--- token usage ---");
  for (const o of agentOutcomes) {
    const u = o.totalUsage;
    const label = `${o.name.padEnd(8)} ${o.provider}/${o.model}`;
    if (!u) {
      console.log(`${label}  no transcript`);
      continue;
    }
    console.log(
      `${label}  in ${u.inputTokens ?? "?"} (cached ${u.cachedInputTokens ?? 0})  out ${u.outputTokens ?? "?"} (reasoning ${u.reasoningTokens ?? 0})  total ${u.totalTokens ?? "?"}`,
    );
  }

  const resultsDir = join(PACKAGE_ROOT, "results");
  mkdirSync(resultsDir, { recursive: true });
  const resultsPath = join(resultsDir, `${cfg.name}-${runId}.json`);
  writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        experiment: cfg.name,
        runId,
        configPath: resolve(configPath),
        network: cfg.network,
        startedAt: new Date(started).toISOString(),
        durationSeconds,
        usdcIssuer: provisioned.usdc.issuer,
        agents: agentOutcomes,
        balances: { before, after, delta: deltas },
        verdict: { rules: verdict.rules, allAgentsExitedClean: allExitedClean, timedOut, pass },
        runDir,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`results → ${resultsPath}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
