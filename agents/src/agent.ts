// One trading subagent. Builds the XMTP + Mosaic capabilities, wraps them as in-process MCP
// servers, then hands control to a Claude Agent SDK query() driven by the trading task prompt.
// Run directly (AGENT_NAME=alice|bob node dist/agent.js) or via demo.js which spawns both.

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { loadAgentConfig } from "./config.js";
import { buildMosaic } from "./mosaic.js";
import { buildXmtp } from "./xmtp.js";
import { makeMosaicServer } from "./tools/mosaicTools.js";
import { makeXmtpServer } from "./tools/xmtpTools.js";
import { systemPrompt, taskPrompt } from "./prompts.js";

const cfg = loadAgentConfig();
const log = (line: string) => console.log(`[${cfg.name}] ${line}`);

function truncate(value: unknown, max = 400): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
}

function logMessage(msg: SDKMessage): void {
  if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
    log(`agent started (model ${(msg as { model?: string }).model ?? cfg.model})`);
    return;
  }
  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text.trim()) log(`💭 ${block.text.trim()}`);
      if (block.type === "tool_use") log(`🔧 ${block.name} ${truncate(block.input, 300)}`);
    }
    return;
  }
  if (msg.type === "user" && typeof msg.message.content !== "string") {
    for (const block of msg.message.content) {
      if (typeof block === "object" && block?.type === "tool_result") {
        const parts = block.content as string | Array<{ type: string; text?: string }> | undefined;
        const body = Array.isArray(parts)
          ? parts.map((c) => (c.type === "text" ? (c.text ?? "") : `<${c.type}>`)).join(" ")
          : String(parts ?? "");
        log(`   ↳ ${truncate(body, 300)}`);
      }
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log("warning: ANTHROPIC_API_KEY is not set — relying on ambient Claude Code credentials");
  }
  log("connecting to Stellar testnet + XMTP dev network…");
  const mosaic = await buildMosaic(cfg);
  const xmtp = await buildXmtp(cfg, log);
  log(`stellar ${mosaic.address} · xmtp ${xmtp.client.inboxId.slice(0, 12)}…`);

  const q = query({
    prompt: taskPrompt(cfg.name),
    options: {
      model: cfg.model,
      systemPrompt: systemPrompt(cfg, mosaic.address),
      mcpServers: {
        xmtp: makeXmtpServer(xmtp),
        mosaic: makeMosaicServer(mosaic, cfg),
      },
      tools: [], // no built-in tools — the agent's whole world is XMTP + Mosaic
      permissionMode: "bypassPermissions",
      maxTurns: 80,
      env: {
        ...(process.env as Record<string, string>),
        // Proof generation runs minutes inside a single MCP tool call; never time it out.
        MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT ?? "1800000",
        MCP_TIMEOUT: process.env.MCP_TIMEOUT ?? "120000",
      },
    },
  });

  let exitCode = 1;
  for await (const msg of q) {
    logMessage(msg);
    if (msg.type === "result") {
      const cost = "total_cost_usd" in msg ? ` · $${msg.total_cost_usd.toFixed(4)}` : "";
      if (msg.subtype === "success") {
        log(`✅ done (${msg.num_turns} turns${cost})`);
        log(msg.result);
        exitCode = 0;
      } else {
        log(`❌ ended without success: ${msg.subtype}${cost}`);
      }
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
