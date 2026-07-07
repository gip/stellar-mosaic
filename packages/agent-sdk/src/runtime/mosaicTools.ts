// The agent's trading capability, adapted from agents/src/tools/mosaicTools.ts: a thin Vercel AI
// SDK tool set over one shared MosaicClient. All amounts are raw 7-decimal integer strings end to
// end. Slow operations say so in their descriptions; execution errors come back as "ERROR: …"
// strings (the system prompt teaches these are recoverable).

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Horizon } from "@stellar/stellar-sdk";
import { SIDE_BUY, SIDE_SELL, type DeskConfig, type NoteLoop } from "@mosaic/sdk";
import type { RuntimeContext } from "./context.js";
import type { MosaicSession } from "./mosaic.js";

const json = (v: unknown) => JSON.stringify(v, null, 2);
const errText = (err: unknown) => `ERROR: ${err instanceof Error ? err.message : String(err)}`;

const amount = z.string().regex(/^[0-9]+$/).describe("Raw integer amount (7 decimals; 1 unit of any asset = 10000000)");

export function makeMosaicTools(session: MosaicSession, ctx: RuntimeContext): ToolSet {
  const { client, desks } = session;
  const horizon = new Horizon.Server(ctx.network.horizonUrl);
  const symbolById = new Map(ctx.desk.assets.map((a) => [a.asset_id, a.symbol]));
  const assetsDesc = ctx.desk.assets.map((a) => `${a.asset_id}=${a.symbol}`).join(", ");
  const pairsDesc = ctx.desk.pairs
    .map((p, i) => `${i} = ${symbolById.get(p.base_asset)}/${symbolById.get(p.quote_asset)} (base/quote)`)
    .join(", ");
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
      description: `Deploy a fresh Mosaic desk (settlement contract) with the configured asset set — assets: ${assetsDesc}; pairs: ${pairsDesc}. Takes ~30-60s. Returns the desk config JSON; send it to every peer verbatim so they can register the same desk.`,
      inputSchema: z.object({
        name: z.string().default("agent-desk").describe("Human-readable desk name"),
      }),
      execute: async (args) => {
        try {
          const desk = await client.deploy({ name: args.name, ...ctx.desk });
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
        "Register a desk created by the desk creator, from the desk-config JSON they sent over XMTP. Validates it carries the configured exact asset/pair set.",
      inputSchema: z.object({
        desk_config_json: z.string().describe("The exact desk config JSON received from the desk creator"),
      }),
      execute: async (args) => {
        try {
          const desk = JSON.parse(args.desk_config_json) as DeskConfig;
          if (!desk.id || !desk.contractId || !Array.isArray(desk.assets) || !Array.isArray(desk.pairs)) {
            throw new Error("desk config missing id/contractId/assets/pairs");
          }
          if (desk.assets.length !== ctx.desk.assets.length || desk.pairs.length !== ctx.desk.pairs.length) {
            throw new Error(
              `expected ${ctx.desk.assets.length} assets (${assetsDesc}) and pairs ${pairsDesc}, got ${desk.assets.length} assets / ${desk.pairs.length} pairs`,
            );
          }
          ctx.desk.assets.forEach((expected, i) => {
            const got = desk.assets[i];
            if (got.asset_id !== expected.asset_id || got.token !== expected.token) {
              throw new Error(`asset ${expected.asset_id} mismatch: expected ${expected.symbol} (token ${expected.token}), got ${JSON.stringify(got)}`);
            }
          });
          ctx.desk.pairs.forEach((expected, i) => {
            const got = desk.pairs[i];
            if (got.base_asset !== expected.base_asset || got.quote_asset !== expected.quote_asset) {
              throw new Error(`pair ${i} mismatch: expected base ${expected.base_asset} / quote ${expected.quote_asset}, got ${JSON.stringify(got)}`);
            }
          });
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
        asset_id: z.number().int().describe(assetsDesc),
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
      description: `Place a private limit order on the desk's on-chain book (pairs: ${pairsDesc}). sell = give the pair's base asset, want quote; buy = give quote, want base. SLOW: generates a zero-knowledge proof in-process — expect 1-5 minutes. If a matching opposite order is already resting, this call settles the trade atomically. Returns the proceeds note; its amount becomes real once the trade settles (see mosaic_wait_for_fill).`,
      inputSchema: z.object({
        desk_id: z.string(),
        pair_id: z.number().int().min(0).default(0).describe(`The pair to trade: ${pairsDesc}`),
        side: z.enum(["buy", "sell"]),
        amount_in: amount.describe("Raw amount you give (the base asset for sell, the quote asset for buy)"),
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
            pairId: args.pair_id,
            side: args.side === "sell" ? SIDE_SELL : SIDE_BUY,
            amountIn: args.amount_in,
            minOut: args.min_out,
            partialAllowed: args.partial_allowed,
          });
          return json({
            placed: { pair_id: args.pair_id, side: args.side, amount_in: args.amount_in, min_out: args.min_out, partial_allowed: args.partial_allowed },
            proceeds_note: noteSummary(note),
          });
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
        asset_id: z.number().int().describe(assetsDesc),
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
