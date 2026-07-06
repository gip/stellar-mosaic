// The agent's trading capability: a thin Vercel AI SDK tool set over one shared MosaicClient. All
// amounts are raw 7-decimal integer strings end to end (the SDK's Amount type) — no floats
// anywhere. Slow operations (place_order, unshield: WASM UltraHonk proving + on-chain confirm) say
// so in their descriptions so the model plans around multi-minute calls. Execution errors come
// back as "ERROR: …" strings (the system prompt teaches that these are recoverable).

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Horizon } from "@stellar/stellar-sdk";
import { SIDE_BUY, SIDE_SELL, type DeskConfig, type NoteLoop } from "@mosaic/sdk";
import type { ResolvedAgentFile } from "../experiment.js";
import { USDC_ASSET_ID, XLM_ASSET_ID, deskSpec, type MosaicSession } from "../mosaic.js";

const json = (v: unknown) => JSON.stringify(v, null, 2);
const errText = (err: unknown) => `ERROR: ${err instanceof Error ? err.message : String(err)}`;

const amount = z.string().regex(/^[0-9]+$/).describe("Raw integer amount (7 decimals; 1 XLM/USDC = 10000000)");

export function makeMosaicTools(session: MosaicSession, cfg: ResolvedAgentFile): ToolSet {
  const { client, desks } = session;
  const horizon = new Horizon.Server(cfg.horizonUrl);
  const loops = new Map<string, NoteLoop>();
  const watch = (deskId: string) => {
    if (!loops.has(deskId)) loops.set(deskId, client.startNoteLoop(deskId, { intervalMs: 3000 }));
  };

  const noteSummary = (n: { id: string; role: string; asset_id: number; symbol: string; amount: string; status: string; indexed: boolean }) => ({
    id: n.id,
    role: n.role,
    asset_id: n.asset_id,
    symbol: n.symbol,
    amount: n.amount,
    status: n.status,
    indexed: n.indexed,
  });

  return {
    mosaic_create_desk: tool({
      description: `Deploy a fresh Mosaic desk (settlement contract) on Stellar testnet with the experiment's fixed asset set — asset ${XLM_ASSET_ID}=XLM (base), asset ${USDC_ASSET_ID}=USDC (quote), pair 0 = XLM/USDC. Takes ~30-60s. Returns the desk config JSON; send it to every peer verbatim so they can register the same desk.`,
      inputSchema: z.object({
        name: z.string().default("agent-experiment-desk").describe("Human-readable desk name"),
      }),
      execute: async (args) => {
        try {
          const desk = await client.deploy({ name: args.name, ...deskSpec(cfg.usdcIssuer) });
          desks.register(desk);
          watch(desk.id);
          return json(desk);
        } catch (err) {
          return errText(err);
        }
      },
    }),
    mosaic_register_desk: tool({
      description:
        "Register a desk created by the desk creator, from the desk-config JSON they sent over XMTP. Validates it is the expected XLM/USDC desk.",
      inputSchema: z.object({
        desk_config_json: z.string().describe("The exact desk config JSON received from the desk creator"),
      }),
      execute: async (args) => {
        try {
          const desk = JSON.parse(args.desk_config_json) as DeskConfig;
          if (!desk.id || !desk.contractId || !Array.isArray(desk.assets) || !Array.isArray(desk.pairs)) {
            throw new Error("desk config missing id/contractId/assets/pairs");
          }
          const pair = desk.pairs[0];
          if (!pair || pair.base_asset !== XLM_ASSET_ID || pair.quote_asset !== USDC_ASSET_ID) {
            throw new Error(`expected pair 0 = base ${XLM_ASSET_ID} (XLM) / quote ${USDC_ASSET_ID} (USDC), got ${JSON.stringify(desk.pairs)}`);
          }
          desks.register(desk);
          watch(desk.id);
          return json({ registered: desk.id, contractId: desk.contractId });
        } catch (err) {
          return errText(err);
        }
      },
    }),
    mosaic_desk_info: tool({
      description: "Show a registered desk's config (contract id, assets, pairs).",
      inputSchema: z.object({ desk_id: z.string() }),
      execute: async (args) => {
        try {
          return json(await desks.get(args.desk_id));
        } catch (err) {
          return errText(err);
        }
      },
    }),
    mosaic_shield: tool({
      description:
        "Move public funds from your Stellar account into a private note on the desk. Shield EXACTLY the amount_in you will trade. Takes ~10-40s.",
      inputSchema: z.object({
        desk_id: z.string(),
        asset_id: z.number().int().describe(`${XLM_ASSET_ID}=XLM, ${USDC_ASSET_ID}=USDC`),
        amount,
      }),
      execute: async (args) => {
        try {
          watch(args.desk_id);
          const { note } = await client.shield({ deskId: args.desk_id, asset_id: args.asset_id, amount: args.amount });
          return json({ shielded: noteSummary(note) });
        } catch (err) {
          return errText(err);
        }
      },
    }),
    mosaic_place_order: tool({
      description:
        "Place a private limit order on the desk's on-chain book (pair 0 = XLM/USDC). sell = give XLM, want USDC; buy = give USDC, want XLM. SLOW: generates a zero-knowledge proof in-process — expect 1-5 minutes. If a matching opposite order is already resting, this call settles the trade atomically. Returns the proceeds note; its amount becomes real once the trade settles (see mosaic_wait_for_fill).",
      inputSchema: z.object({
        desk_id: z.string(),
        side: z.enum(["buy", "sell"]),
        amount_in: amount.describe("Raw amount you give (XLM for sell, USDC for buy)"),
        min_out: amount.describe("Raw minimum you accept in return"),
        partial_allowed: z
          .boolean()
          .describe(
            "MUST be true for the FIRST order of the pair: only partial_allowed orders may rest on the book (a non-partial order that cannot fill immediately is rejected fill-or-kill). Use false for the SECOND (matching) order so it either fully fills the resting one or reverts.",
          ),
      }),
      execute: async (args) => {
        try {
          watch(args.desk_id);
          const { note } = await client.placeOrder({
            deskId: args.desk_id,
            pairId: 0,
            side: args.side === "sell" ? SIDE_SELL : SIDE_BUY,
            amountIn: args.amount_in,
            minOut: args.min_out,
            partialAllowed: args.partial_allowed,
          });
          return json({ placed: { side: args.side, amount_in: args.amount_in, min_out: args.min_out, partial_allowed: args.partial_allowed }, proceeds_note: noteSummary(note) });
        } catch (err) {
          return errText(err);
        }
      },
    }),
    mosaic_wait_for_fill: tool({
      description:
        "Wait until an order's proceeds note is settled on-chain (i.e. the trade executed) and return its real amount. Returns 'TIMEOUT' if not filled in time — the counterparty may still be proving; you can wait again.",
      inputSchema: z.object({
        desk_id: z.string(),
        note_id: z.string().describe("The proceeds_note id returned by mosaic_place_order"),
        timeout_seconds: z.number().int().min(1).max(900).default(300),
      }),
      execute: async (args) => {
        try {
          watch(args.desk_id);
          const deadline = Date.now() + args.timeout_seconds * 1000;
          while (Date.now() < deadline) {
            const notes = await client.noteManager.forDesk(args.desk_id);
            const note = notes.find((n) => n.id === args.note_id);
            if (!note) throw new Error(`no note ${args.note_id} on desk ${args.desk_id}`);
            if (note.indexed) return json({ filled: noteSummary(note) });
            await new Promise((r) => setTimeout(r, 2000));
          }
          return `TIMEOUT: order proceeds not settled after ${args.timeout_seconds}s`;
        } catch (err) {
          return errText(err);
        }
      },
    }),
    mosaic_cancel_order: tool({
      description:
        "Cancel your RESTING (unfilled) order and reclaim its shielded funds as a private note — use this when a negotiated trade falls through after you placed the first order, so funds never sit idle. Pass the proceeds_note id returned by mosaic_place_order. Fails if the order already filled. SLOW: generates a zero-knowledge proof — expect 1-5 minutes. Returns the refund note; once indexed it can be traded or unshielded.",
      inputSchema: z.object({
        desk_id: z.string(),
        note_id: z.string().describe("The proceeds_note id of the order to cancel"),
      }),
      execute: async (args) => {
        try {
          watch(args.desk_id);
          const { note } = await client.cancelOrder({ deskId: args.desk_id, noteId: args.note_id });
          return json({ cancelled: args.note_id, refund_note: noteSummary(note) });
        } catch (err) {
          return errText(err);
        }
      },
    }),
    mosaic_list_notes: tool({
      description: "List your private notes on a desk (spendable balances, pending orders, proceeds).",
      inputSchema: z.object({ desk_id: z.string() }),
      execute: async (args) => {
        try {
          const notes = await client.noteManager.forDesk(args.desk_id);
          return json(notes.map(noteSummary));
        } catch (err) {
          return errText(err);
        }
      },
    }),
    mosaic_unshield: tool({
      description: `Withdraw shielded funds to YOUR OWN public Stellar account (${session.address}). SLOW: generates a zero-knowledge proof — expect 1-5 minutes.`,
      inputSchema: z.object({
        desk_id: z.string(),
        asset_id: z.number().int().describe(`${XLM_ASSET_ID}=XLM, ${USDC_ASSET_ID}=USDC`),
        amount,
      }),
      execute: async (args) => {
        try {
          await client.unshield({
            deskId: args.desk_id,
            asset_id: args.asset_id,
            amount: args.amount,
            recipient: session.address,
          });
          return json({ unshielded: { asset_id: args.asset_id, amount: args.amount, to: session.address } });
        } catch (err) {
          return errText(err);
        }
      },
    }),
    mosaic_wallet_balances: tool({
      description: "Your public Stellar account balances (post-unshield verification).",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const account = await horizon.loadAccount(session.address);
          const balances = account.balances.map((b) => ({
            asset: b.asset_type === "native" ? "XLM" : `${(b as { asset_code?: string }).asset_code}`,
            balance: b.balance,
          }));
          return json({ address: session.address, balances });
        } catch (err) {
          return errText(err);
        }
      },
    }),
  };
}
