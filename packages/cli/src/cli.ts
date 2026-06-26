#!/usr/bin/env node
// mosaic — headless CLI for the Stellar Mosaic privacy DEX. Drives the protocol fully locally with
// your own funded key (no backend): shield, place/cancel orders, unshield, and track notes in a
// local SQLite store. Built entirely on @mosaic/sdk, so it shares one code path with the web app.

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { createNodeClient } from "@mosaic/sdk/node";
import { SIDE_BUY, SIDE_SELL, SecretKeySigner, type McpClient, type Side } from "@mosaic/sdk";
import { createMcpClient } from "@mosaic/sdk/mcp-client";
import { dbPath, load, requireKey, save, type CliConfig } from "./config.js";
import { StellarCliDeployer } from "./deployer.js";

function build(cfg: CliConfig, opts: { withDeployer?: boolean; mcp?: McpClient } = {}) {
  const secretKey = requireKey(cfg);
  const deployer = opts.withDeployer
    ? new StellarCliDeployer({ network: cfg.network, source: secretKey })
    : undefined;
  return createNodeClient({
    network: cfg.network,
    secretKey,
    dbPath: dbPath(),
    desks: cfg.desks,
    startLedger: cfg.startLedger,
    deployer,
    mcp: opts.mcp,
  });
}

function parseSide(s: string): Side {
  const v = s.toLowerCase();
  if (v === "sell") return SIDE_SELL;
  if (v === "buy") return SIDE_BUY;
  throw new Error(`side must be "buy" or "sell", got "${s}"`);
}

const program = new Command();
program
  .name("mosaic")
  .description("Headless CLI for the Stellar Mosaic privacy DEX (fully local, your own key).")
  .version("0.0.0");

// --- keys -----------------------------------------------------------------------------------------
const keys = program.command("keys").description("Manage the signing key");
keys
  .command("generate")
  .description("Generate a fresh Stellar key and store it")
  .action(() => {
    const cfg = load();
    const kp = Keypair.random();
    cfg.secretKey = kp.secret();
    save(cfg);
    console.log(`Generated key. Public: ${kp.publicKey()}\nNext: mosaic fund`);
  });
keys
  .command("show")
  .description("Show the configured public key")
  .action(() => {
    const cfg = load();
    console.log(Keypair.fromSecret(requireKey(cfg)).publicKey());
  });

// --- fund -----------------------------------------------------------------------------------------
program
  .command("fund")
  .argument("[address]", "address to fund (default: your own)")
  .description("Fund an account via Friendbot (testnet)")
  .action(async (address?: string) => {
    const cfg = load();
    const { client } = build(cfg);
    const target = address ?? Keypair.fromSecret(requireKey(cfg)).publicKey();
    await client.fund(target);
    console.log(`Funded ${target}`);
  });

// --- desks ----------------------------------------------------------------------------------------
const desk = program.command("desk").description("Manage known desks");
desk
  .command("add")
  .argument("<file>", "path to a desk-config JSON ({ id, contractId, assets, pairs })")
  .description("Register an existing desk")
  .action((file: string) => {
    const cfg = load();
    const d = JSON.parse(readFileSync(file, "utf8"));
    cfg.desks = [...cfg.desks.filter((x) => x.id !== d.id), d];
    save(cfg);
    console.log(`Registered desk ${d.id} (${d.contractId})`);
  });
desk
  .command("list")
  .description("List known desks")
  .action(() => {
    for (const d of load().desks) console.log(`${d.id}\t${d.contractId}\t${d.name ?? ""}`);
  });

// --- deploy ---------------------------------------------------------------------------------------
program
  .command("deploy")
  .argument("<spec>", "path to a deploy spec JSON ({ name?, assets, pairs })")
  .description("Deploy a fresh desk via the stellar CLI and register it")
  .action(async (spec: string) => {
    const cfg = load();
    const { client, desks } = build(cfg, { withDeployer: true });
    const ledger = (await new rpc.Server(cfg.network.rpcUrl).getLatestLedger()).sequence;
    const parsed = JSON.parse(readFileSync(spec, "utf8"));
    const deskCfg = await client.deploy(parsed);
    desks.register(deskCfg);
    cfg.desks = [...cfg.desks, deskCfg];
    cfg.startLedger = cfg.startLedger ? Math.min(cfg.startLedger, ledger) : ledger;
    save(cfg);
    console.log(`Deployed desk ${deskCfg.id}\ncontract: ${deskCfg.contractId}`);
  });

// --- operations -----------------------------------------------------------------------------------
program
  .command("shield")
  .argument("<deskId>")
  .argument("<assetId>")
  .argument("<amount>", "raw amount (base units)")
  .description("Shield an asset into a private note")
  .action(async (deskId: string, assetId: string, amount: string) => {
    const { client } = build(load());
    const { note } = await client.shield({ deskId, asset_id: Number(assetId), amount });
    console.log(`Shielded note ${note.id} (owner_tag ${note.owner_tag})`);
  });

program
  .command("order")
  .argument("<deskId>")
  .argument("<pairId>")
  .argument("<side>", "buy | sell")
  .argument("<amountIn>", "raw amount offered")
  .argument("<minOut>", "raw minimum out")
  .option("--partial", "allow partial fills", false)
  .description("Place a private limit order")
  .action(async (deskId, pairId, side, amountIn, minOut, opts) => {
    const { client } = build(load());
    const { note } = await client.placeOrder({
      deskId,
      pairId: Number(pairId),
      side: parseSide(side),
      amountIn,
      minOut,
      partialAllowed: Boolean(opts.partial),
    });
    console.log(`Placed order; proceeds note ${note.id}`);
  });

program
  .command("unshield")
  .argument("<deskId>")
  .argument("<assetId>")
  .argument("<amount>")
  .argument("<recipient>", "Stellar address to receive funds")
  .description("Withdraw an exact amount to a Stellar recipient")
  .action(async (deskId, assetId, amount, recipient) => {
    const { client } = build(load());
    await client.unshield({ deskId, asset_id: Number(assetId), amount, recipient });
    console.log(`Unshielded ${amount} of asset ${assetId} to ${recipient}`);
  });

program
  .command("cancel")
  .argument("<deskId>")
  .argument("<noteId>", "the order-output note id")
  .description("Cancel a resting order and reclaim the funds")
  .action(async (deskId, noteId) => {
    const { client } = build(load());
    const { note } = await client.cancelOrder({ deskId, noteId });
    console.log(`Cancelled; refund note ${note.id}`);
  });

// --- base shield (requires an MCP) ----------------------------------------------------------------
program
  .command("base-shield")
  .argument("<deskId>")
  .argument("<assetId>")
  .argument("<amount>")
  .argument("<baseTxHash>", "the Base deposit transaction hash")
  .requiredOption("--mcp <url>", "Mosaic MCP server URL")
  .description("Shield a Base deposit into a private note via the MCP (auth + prove + mint)")
  .action(async (deskId, assetId, amount, baseTxHash, opts) => {
    const cfg = load();
    const mcp = createMcpClient({ url: opts.mcp });
    await mcp.authenticate(new SecretKeySigner(requireKey(cfg)));
    const { client } = build(cfg, { mcp });
    const res = await client.shieldFromBase({ deskId, asset_id: Number(assetId), amount, baseTxHash });
    console.log(`Base shield submitted: ${res.txHash} (owner_tag ${res.owner_tag})`);
  });

// --- notes ----------------------------------------------------------------------------------------
program
  .command("notes")
  .argument("[deskId]", "filter by desk (default: all known desks)")
  .description("List local notes")
  .action(async (deskId?: string) => {
    const cfg = load();
    const { client } = build(cfg);
    const deskIds = deskId ? [deskId] : cfg.desks.map((d) => d.id);
    for (const id of deskIds) {
      const notes = await client.noteManager.forDesk(id);
      for (const n of notes) {
        const flags = `${n.status}${n.indexed ? "" : ",pending"}`;
        console.log(`${id}\t${n.id}\t${n.role}\tasset ${n.asset_id}\t${n.amount}\t${flags}`);
      }
    }
  });

// --- watch ----------------------------------------------------------------------------------------
program
  .command("watch")
  .argument("<deskId>")
  .option("--interval <ms>", "poll interval", "3000")
  .description("Continuously reconcile local notes against the chain")
  .action(async (deskId: string, opts: { interval: string }) => {
    const { client } = build(load());
    const loop = client.startNoteLoop(deskId, { intervalMs: Number(opts.interval) });
    console.log(`Watching ${deskId} (Ctrl-C to stop)…`);
    process.on("SIGINT", () => {
      loop.stop();
      process.exit(0);
    });
    await new Promise(() => {}); // run until interrupted
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
