// One trading agent child process. Reads its resolved config (identities, provider, model, prompt)
// from the JSON file named by AGENT_FILE, builds the XMTP + Mosaic capabilities as AI SDK tools,
// then hands control to a generateText() tool loop — identical for Anthropic and OpenAI models.
// Writes a structured transcript to <runDir>/<name>.transcript.json for the results file.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateText, stepCountIs, type StepResult, type ToolSet } from "ai";
import type { ResolvedAgentFile } from "./experiment.js";
import { languageModel, webSearchTools } from "./llm.js";
import { buildMosaic } from "./mosaic.js";
import { buildXmtp } from "./xmtp.js";
import { makeMosaicTools } from "./tools/mosaicTools.js";
import { makeXmtpTools } from "./tools/xmtpTools.js";
import { systemPrompt } from "./prompts.js";

const agentFile = process.env.AGENT_FILE;
if (!agentFile) {
  console.error("AGENT_FILE env var is required (path to the resolved agent JSON)");
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(agentFile, "utf8")) as ResolvedAgentFile;
const log = (line: string) => console.log(`[${cfg.name}] ${line}`);

function truncate(value: unknown, max = 400): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
}

interface TranscriptStep {
  text?: string;
  toolCalls: { toolName: string; input: unknown }[];
  toolResults: { toolName: string; output: unknown }[];
  finishReason: string;
  usage: unknown;
}

const transcriptSteps: TranscriptStep[] = [];
const startedAt = new Date().toISOString();

function onStep(step: StepResult<ToolSet>): void {
  if (step.text.trim()) log(`💭 ${step.text.trim()}`);
  for (const call of step.toolCalls) log(`🔧 ${call.toolName} ${truncate(call.input, 300)}`);
  for (const result of step.toolResults) log(`   ↳ ${truncate(result.output, 300)}`);
  transcriptSteps.push({
    text: step.text || undefined,
    toolCalls: step.toolCalls.map((c) => ({ toolName: c.toolName, input: c.input })),
    toolResults: step.toolResults.map((r) => ({ toolName: r.toolName, output: r.output })),
    finishReason: step.finishReason,
    usage: step.usage,
  });
}

function writeTranscript(extra: Record<string, unknown>): void {
  writeFileSync(
    join(cfg.runDir, `${cfg.name}.transcript.json`),
    JSON.stringify(
      {
        name: cfg.name,
        provider: cfg.provider,
        model: cfg.model,
        startedAt,
        finishedAt: new Date().toISOString(),
        steps: transcriptSteps,
        ...extra,
      },
      null,
      2,
    ) + "\n",
  );
}

// The orchestrator SIGTERMs stragglers at the run's wall-clock cap — flush what we have so the
// postmortem still has the partial transcript.
process.on("SIGTERM", () => {
  log("received SIGTERM (run timeout) — flushing transcript and exiting");
  try {
    writeTranscript({ error: "killed: run wall-clock timeout (SIGTERM)" });
  } catch {
    // best effort
  }
  process.exit(143);
});

async function main(): Promise<void> {
  log(`connecting to Stellar (${cfg.network.rpcUrl}) + XMTP dev network…`);
  const mosaic = await buildMosaic(cfg);
  const xmtp = await buildXmtp(cfg, log);
  log(`stellar ${mosaic.address} · xmtp ${xmtp.client.inboxId.slice(0, 12)}… · ${cfg.provider}/${cfg.model}`);

  const result = await generateText({
    model: languageModel(cfg.provider, cfg.apiKey, cfg.model),
    system: systemPrompt(cfg),
    prompt: cfg.prompt,
    tools: {
      ...makeXmtpTools(xmtp),
      ...makeMosaicTools(mosaic, cfg),
      ...(cfg.webSearch ? webSearchTools(cfg.provider, cfg.apiKey) : {}),
    },
    stopWhen: stepCountIs(cfg.maxTurns),
    onStepFinish: onStep,
  });

  const usage = result.totalUsage;
  const tokens = `${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out tokens`;
  writeTranscript({ finishReason: result.finishReason, totalUsage: usage, finalText: result.text });

  // "stop" means the model concluded on its own; anything else (step cap, length) is a non-finish.
  // (The final summary text was already logged as the last step's 💭 line.)
  if (result.finishReason === "stop") {
    log(`✅ done (${result.steps.length} turns · ${tokens})`);
    process.exit(0);
  } else {
    log(`❌ ended without a final answer (finishReason=${result.finishReason}, ${result.steps.length} turns · ${tokens})`);
    process.exit(1);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log(`fatal: ${message}`);
  try {
    writeTranscript({ error: message });
  } catch {
    // best effort — the run dir may not exist if config parsing failed
  }
  process.exit(1);
});
