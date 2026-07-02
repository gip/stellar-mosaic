// Base -> Stellar shield step functions used by the durable worker (baseShieldWorker.ts).
//
// Proving no longer runs here: it lives in the remote Rust prove service (an async submit/poll HTTP
// wrapper around bridge-prover). This module is the thin client + the two steps the MCP host still
// owns: waiting for Base finality (a direct JSON-RPC check) and submitting the on-chain mint
// (`attest_base_block` + `shield_from_base`) with the desk sponsor via the `stellar` CLI.
//
// The heavy prove (~10 min) is never a held connection: submit returns immediately and the worker
// polls. Every call here is short.

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BaseShieldConfig {
  /** Base URL of the remote prove service (e.g. `http://prover-host:8787`). */
  proveServiceUrl: string;
  /** Shared bearer token; must match the prove service's `MOSAIC_PROVER_TOKEN`. */
  proveToken: string;
  /** Base (Sepolia) RPC URL, used for the direct `eth_getBlockByNumber("finalized")` check. */
  baseRpc: string;
  /** Stellar network + RPC the mint is submitted against (sponsor secret comes per-desk from the store). */
  stellar: { rpcUrl: string; networkPassphrase: string };
}

/** A prove job status as reported by the remote service. */
export type ProveResult =
  | { status: "running" | "not_started" }
  | { status: "done"; seal_hex: string; journal_hex: string; block_number: number; block_hash: string }
  | { status: "error"; error: string };

/** Build a config from environment variables, or undefined if the server isn't set up for Base. */
export function baseShieldConfigFromEnv(): BaseShieldConfig | undefined {
  const e = process.env;
  if (!e.MOSAIC_PROVE_SERVICE_URL || !e.MOSAIC_PROVE_TOKEN || !e.MOSAIC_BASE_RPC) {
    return undefined;
  }
  return {
    proveServiceUrl: e.MOSAIC_PROVE_SERVICE_URL.replace(/\/+$/, ""),
    proveToken: e.MOSAIC_PROVE_TOKEN,
    baseRpc: e.MOSAIC_BASE_RPC,
    stellar: {
      rpcUrl: e.MOSAIC_RPC ?? "https://soroban-testnet.stellar.org",
      networkPassphrase: e.MOSAIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    },
  };
}

/** The committed block from the 256-byte ABI journal (word 0 low 8 bytes = number; word 1 = hash). */
export function parseJournalBlock(journal: Buffer): { blockNumber: number; blockHash: string } {
  if (journal.length !== 256) throw new Error("journal is not 256 bytes");
  const blockNumber = Number(journal.readBigUInt64BE(24));
  const blockHash = journal.subarray(32, 64).toString("hex");
  return { blockNumber, blockHash };
}

const authHeaders = (cfg: BaseShieldConfig) => ({
  authorization: `Bearer ${cfg.proveToken}`,
  "content-type": "application/json",
});

/** Idempotently submit (or re-observe) a prove job keyed by the base-shield job id. */
export async function submitProve(
  cfg: BaseShieldConfig,
  args: { jobId: string; bridge: string; depositId: number },
): Promise<ProveResult> {
  const res = await fetch(`${cfg.proveServiceUrl}/prove/base-deposit`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ job_id: args.jobId, bridge: args.bridge, deposit_id: args.depositId }),
  });
  if (!res.ok) throw new Error(`prove submit failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ProveResult;
}

/** Poll a prove job's status without starting anything. */
export async function pollProve(cfg: BaseShieldConfig, jobId: string): Promise<ProveResult> {
  const res = await fetch(`${cfg.proveServiceUrl}/prove/base-deposit/${encodeURIComponent(jobId)}`, {
    headers: authHeaders(cfg),
  });
  if (!res.ok) throw new Error(`prove poll failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ProveResult;
}

/**
 * Has Base finalized through `blockNumber`? A pure block-number check via `eth_getBlockByNumber`
 * against the "finalized" tag — no eth_getProof, no foundry `cast` on this host.
 */
export async function isFinalized(baseRpc: string, blockNumber: number): Promise<boolean> {
  const res = await fetch(baseRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["finalized", false] }),
  });
  if (!res.ok) throw new Error(`base rpc finalized query failed: ${res.status}`);
  const body = (await res.json()) as { result?: { number?: string }; error?: { message?: string } };
  if (body.error) throw new Error(`base rpc error: ${body.error.message ?? "unknown"}`);
  const hex = body.result?.number;
  if (!hex) throw new Error("base rpc returned no finalized block");
  return Number(BigInt(hex)) >= blockNumber;
}

/**
 * Attest the proven block hash, then submit `shield_from_base`, both signed by the desk sponsor.
 * Writes the seal/journal to a scratch dir first (the CLI takes file paths). Returns the mint tx.
 */
export async function mintOnStellar(
  cfg: BaseShieldConfig,
  args: {
    contractId: string;
    sponsorSecret: string;
    jobId: string;
    blockNumber: number;
    blockHash: string;
    sealHex: string;
    journalHex: string;
  },
): Promise<{ txHash: string }> {
  const outDir = join(tmpdir(), "mosaic-base-shield", args.jobId);
  mkdirSync(outDir, { recursive: true });
  const sealPath = join(outDir, "seal.bin");
  const journalPath = join(outDir, "journal.bin");
  writeFileSync(sealPath, Buffer.from(args.sealHex, "hex"));
  writeFileSync(journalPath, Buffer.from(args.journalHex, "hex"));

  const net = ["--rpc-url", cfg.stellar.rpcUrl, "--network-passphrase", cfg.stellar.networkPassphrase];
  // Async so the ~seconds-long stellar CLI round-trips never block the single-threaded MCP server.
  const invoke = async (fnArgs: string[]) =>
    (
      await execFileAsync(
        "stellar",
        ["contract", "invoke", "--id", args.contractId, "--source-account", args.sponsorSecret, ...net, "--send", "yes", "--", ...fnArgs],
        { encoding: "utf8" },
      )
    ).stdout;
  await invoke(["attest_base_block", "--block_number", String(args.blockNumber), "--block_hash", args.blockHash]);
  const out = await invoke(["shield_from_base", "--seal-file-path", sealPath, "--journal-file-path", journalPath]);
  return { txHash: out.trim().split(/\s+/).pop() ?? "" };
}
