// The agent's messaging capability, as a Vercel AI SDK tool set. Waiting returns a structured
// timeout result instead of throwing so the model can decide to retry or re-send; execution errors
// come back as "ERROR: …" strings (the system prompt teaches that these are recoverable).

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { XmtpSession } from "../xmtp.js";

const errText = (err: unknown) => `ERROR: ${err instanceof Error ? err.message : String(err)}`;

export function makeXmtpTools(session: XmtpSession): ToolSet {
  const peerNames = session.peers.map((p) => p.name).join(", ");
  return {
    xmtp_send: tool({
      description:
        "Send a message to a peer agent over XMTP. Use plain language for negotiation; embed JSON blobs verbatim when the protocol calls for them.",
      inputSchema: z.object({
        to: z
          .string()
          .optional()
          .describe(`Peer name (${peerNames}). Optional when there is exactly one peer.`),
        text: z.string().describe("The message to send"),
      }),
      execute: async ({ to, text }) => {
        try {
          await session.send(to, text);
          return "sent";
        } catch (err) {
          return errText(err);
        }
      },
    }),
    xmtp_wait_for_message: tool({
      description:
        "Wait for the next unread message from any peer. Returns {from, text} JSON, or 'TIMEOUT' if nothing arrives in time (you may simply wait again — a counterparty could be proving, which takes minutes).",
      inputSchema: z.object({
        timeout_seconds: z.number().int().min(1).max(900).default(180).describe("How long to wait"),
        from: z.string().optional().describe("Only accept messages from this peer (others stay queued)"),
      }),
      execute: async ({ timeout_seconds, from }) => {
        const deadline = Date.now() + timeout_seconds * 1000;
        while (Date.now() < deadline) {
          const idx = from
            ? session.inbox.findIndex((m) => m.from.toLowerCase() === from.toLowerCase())
            : session.inbox.length > 0
              ? 0
              : -1;
          if (idx >= 0) {
            const [next] = session.inbox.splice(idx, 1);
            return JSON.stringify(next);
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        return `TIMEOUT: no message received in ${timeout_seconds}s`;
      },
    }),
    xmtp_history: tool({
      description: "The full conversation transcript so far (all peers, both directions), oldest first.",
      inputSchema: z.object({}),
      execute: async () => JSON.stringify(session.transcript, null, 2),
    }),
  };
}
