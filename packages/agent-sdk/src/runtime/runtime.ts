// One agent process end to end (the `run-agent` child, adapted from agents/src/agentMain.ts):
// rebuild the identity from the agent root, authenticate, pull the web-edited config, open XMTP
// (peers + backend log channel on one client), build the Mosaic trading client, then hand control
// to a generateText() tool loop. Every step is mirrored into the session log with the configured
// visibility.

import { homedir } from "node:os";
import { join } from "node:path";
import { generateText, stepCountIs, type StepResult, type ToolSet } from "ai";
import { AgentBackendClient } from "../backendClient.js";
import { agentIdentityFromRoot } from "../derive.js";
import { startAgentSession, type AgentSession } from "../session.js";
import type { AgentConfig, LogEnvelope } from "../types.js";
import { buildDeskSpec, DEFAULT_NETWORK, type RuntimeContext } from "./context.js";
import { languageModel, webSearchTools, type Provider } from "./llm.js";
import { buildMosaic } from "./mosaic.js";
import { makeMosaicTools } from "./mosaicTools.js";
import { resolvePrompt } from "./presets.js";
import { systemPrompt } from "./prompts.js";
import { buildAgentXmtp } from "./xmtpSession.js";
import { makeXmtpTools } from "./xmtpTools.js";

export interface RunAgentOptions {
  agentRoot: Uint8Array;
  apiKey: string;
  backendUrl: string;
  /** Base directory for per-agent state (default `~/.mosaic-agent`). */
  dataDirBase?: string;
  log?: (line: string) => void;
}

export interface RunAgentResult {
  finishReason: string;
  steps: number;
}

function truncate(value: unknown, max = 2000): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
}

function validConfig(raw: unknown): AgentConfig {
  const config = raw as AgentConfig | undefined;
  if (!config || config.version !== 1) throw new Error("agent-config missing or unsupported (configure the agent on the web first)");
  if (config.provider !== "openai" && config.provider !== "anthropic") throw new Error("agent-config provider must be openai or anthropic");
  if (!config.model) throw new Error("agent-config has no model");
  if (!config.desk) throw new Error("agent-config has no desk (assets/pairs) — configure the trading universe on the web");
  return config;
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const identity = await agentIdentityFromRoot(opts.agentRoot);
  const log = opts.log ?? ((line: string) => console.log(`[agent ${identity.stellarPublicKey.slice(0, 8)}] ${line}`));
  const dataDir = join(opts.dataDirBase ?? join(homedir(), ".mosaic-agent"), identity.stellarPublicKey);

  const infoClient = new AgentBackendClient(opts.backendUrl);
  const info = await infoClient.info();

  // One XMTP client serves both the peer DMs and the backend log channel.
  const xmtp = await buildAgentXmtp({
    identity,
    backendXmtpAddress: info.xmtp_address,
    env: info.xmtp_env,
    dataDir,
    log,
  });
  if (!xmtp.sendToBackend) log("backend has no XMTP inbox — session logs are disabled for this run");

  const session: AgentSession = await startAgentSession({
    backendUrl: opts.backendUrl,
    identity,
    createLogger: async () => ({
      log: async (envelope: LogEnvelope) => {
        await xmtp.sendToBackend?.(JSON.stringify(envelope));
      },
      close: async () => {},
    }),
  });

  try {
    const config = validConfig(await session.openAttached("agent-config"));
    const visibility = config.params?.logVisibility ?? "private";
    const ctx: RuntimeContext = {
      identity,
      name: session.agent.name ?? identity.stellarPublicKey.slice(0, 8),
      config,
      desk: buildDeskSpec(config.desk!),
      mandate: resolvePrompt(config.prompt),
      apiKey: opts.apiKey,
      backendUrl: opts.backendUrl,
      dataDir,
      network: {
        horizonUrl: config.network?.horizonUrl ?? DEFAULT_NETWORK.horizonUrl,
        rpcUrl: config.network?.rpcUrl ?? DEFAULT_NETWORK.rpcUrl,
        networkPassphrase: info.network_passphrase,
        friendbotUrl: config.network?.friendbotUrl ?? DEFAULT_NETWORK.friendbotUrl,
      },
      xmtpEnv: info.xmtp_env,
      log,
    };

    await xmtp.connectPeers((config.peers ?? []).map((p) => ({ name: p.name, ethAddress: p.eth_address })));
    log(`connecting to Stellar (${ctx.network.rpcUrl})…`);
    const mosaic = await buildMosaic(ctx);
    log(`stellar ${mosaic.address} · xmtp ${xmtp.client.inboxId.slice(0, 12)}… · ${config.provider}/${config.model}`);

    const provider = config.provider as Provider;
    const maxTurns = config.params?.maxTurns ?? 80;
    const timeoutMinutes = config.params?.timeoutMinutes ?? 45;
    const controller = new AbortController();
    const wallClock = setTimeout(() => controller.abort(new Error("wall-clock timeout")), timeoutMinutes * 60_000);
    wallClock.unref?.();

    // The daemon SIGTERMs on stop; end the session so the log stream closes cleanly.
    const onTerm = () => {
      log("received SIGTERM — ending session");
      controller.abort(new Error("stopped"));
      void session.end().finally(() => process.exit(143));
    };
    process.once("SIGTERM", onTerm);

    const onStep = (step: StepResult<ToolSet>): void => {
      if (step.text.trim()) log(`💭 ${step.text.trim()}`);
      for (const call of step.toolCalls) log(`🔧 ${call.toolName} ${truncate(call.input, 300)}`);
      void session
        .log(
          {
            step: {
              text: step.text || undefined,
              tool_calls: step.toolCalls.map((c) => ({ name: c.toolName, input: c.input })),
              tool_results: step.toolResults.map((r) => ({ name: r.toolName, output: truncate(r.output) })),
              finish_reason: step.finishReason,
              usage: step.usage,
            },
          },
          { visibility },
        )
        .catch((err: unknown) => log(`session log failed: ${err instanceof Error ? err.message : String(err)}`));
    };

    const result = await generateText({
      model: languageModel(provider, opts.apiKey, config.model),
      system: systemPrompt(ctx),
      prompt: ctx.mandate,
      tools: {
        ...makeXmtpTools(xmtp),
        ...makeMosaicTools(mosaic, ctx),
        ...(config.params?.webSearch ? webSearchTools(provider, opts.apiKey) : {}),
      },
      stopWhen: stepCountIs(maxTurns),
      abortSignal: controller.signal,
      onStepFinish: onStep,
    });

    clearTimeout(wallClock);
    process.off("SIGTERM", onTerm);
    await session.log(
      { summary: { finish_reason: result.finishReason, steps: result.steps.length, usage: result.totalUsage, final_text: result.text } },
      { visibility },
    );
    return { finishReason: result.finishReason, steps: result.steps.length };
  } finally {
    await session.end().catch(() => {});
  }
}
