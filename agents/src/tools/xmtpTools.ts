// The agent's messaging capability, exposed as an in-process MCP server. Waiting returns a
// structured timeout result instead of throwing so the model can decide to retry or re-send.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { XmtpSession } from "../xmtp.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: `ERROR: ${err instanceof Error ? err.message : String(err)}` }],
});

export function makeXmtpServer(session: XmtpSession) {
  return createSdkMcpServer({
    name: "xmtp",
    version: "1.0.0",
    tools: [
      tool(
        "xmtp_send",
        "Send a message to the counterparty agent over XMTP. Use plain language for negotiation; embed JSON blobs verbatim when the protocol calls for them.",
        { text: z.string().describe("The message to send") },
        async (args) => {
          try {
            await session.send(args.text);
            return text("sent");
          } catch (err) {
            return fail(err);
          }
        },
      ),
      tool(
        "xmtp_wait_for_message",
        "Wait for the next unread message from the counterparty. Returns the message text, or 'TIMEOUT' if nothing arrives in time (you may simply wait again — the counterparty could be proving, which takes minutes).",
        { timeout_seconds: z.number().int().min(1).max(900).default(180).describe("How long to wait") },
        async (args) => {
          const deadline = Date.now() + args.timeout_seconds * 1000;
          while (Date.now() < deadline) {
            const next = session.inbox.shift();
            if (next !== undefined) return text(next);
            await new Promise((r) => setTimeout(r, 500));
          }
          return text(`TIMEOUT: no message received in ${args.timeout_seconds}s`);
        },
      ),
      tool(
        "xmtp_history",
        "The full conversation transcript so far (both directions), oldest first.",
        {},
        async () => text(JSON.stringify(session.transcript, null, 2)),
      ),
    ],
  });
}
