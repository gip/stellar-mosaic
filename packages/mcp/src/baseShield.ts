// Base -> Stellar shield orchestration, mirroring backend/src/base_shield.rs. This is the one flow
// that genuinely needs a server: it shells out to the RISC Zero `bridge-prover` (prove the Base
// deposit while it is still in the eth_getProof window), waits for Base finality via `cast`, then
// attests the block hash and submits `shield_from_base` with the desk SPONSOR key. It is gated by
// configuration — if the prover/relayer aren't set up, the tool returns a clear error instead.
//
// Untestable in CI (requires the prover binary, a Base RPC, Foundry's `cast`, and a funded sponsor),
// so it is intentionally thin and faithful to the Rust pipeline rather than re-derived.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface BaseShieldConfig {
  /** Directory containing the bridge-prover `run-host` binary. */
  proverDir: string;
  /** Foundry `cast` binary (for the finality check). */
  castBin: string;
  /** Base RPC URL. */
  baseRpc: string;
  /** MosaicBridge contract address on Base. */
  bridgeAddress: string;
  /** Stellar network + the desk sponsor secret that pays for / authorizes the mint. */
  stellar: { rpcUrl: string; networkPassphrase: string; sponsorSecret: string };
}

export interface BaseShieldArgs {
  contractId: string;
  asset_id: number;
  amount: string;
  owner_tag: string;
  baseTxHash: string;
}

/** Build a config from environment variables, or undefined if the server isn't set up for Base. */
export function baseShieldConfigFromEnv(): BaseShieldConfig | undefined {
  const e = process.env;
  if (!e.MOSAIC_PROVER_DIR || !e.MOSAIC_BASE_RPC || !e.MOSAIC_BRIDGE_ADDRESS || !e.MOSAIC_SPONSOR_SECRET) {
    return undefined;
  }
  return {
    proverDir: e.MOSAIC_PROVER_DIR,
    castBin: e.MOSAIC_CAST_BIN ?? "cast",
    baseRpc: e.MOSAIC_BASE_RPC,
    bridgeAddress: e.MOSAIC_BRIDGE_ADDRESS,
    stellar: {
      rpcUrl: e.MOSAIC_RPC ?? "https://soroban-testnet.stellar.org",
      networkPassphrase: e.MOSAIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
      sponsorSecret: e.MOSAIC_SPONSOR_SECRET,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run the full prove -> finality -> mint pipeline, returning the mint transaction hash. */
export async function runBaseShield(
  cfg: BaseShieldConfig,
  args: BaseShieldArgs,
): Promise<{ owner_tag: string; txHash: string }> {
  const outDir = join(cfg.proverDir, "out", args.baseTxHash);
  mkdirSync(outDir, { recursive: true });

  // 1. Prove the deposit at the current (in-window) Base head. The seal commits the proven block.
  execFileSync(
    join(cfg.proverDir, "run-host"),
    [
      "--prove",
      "--rpc-url",
      cfg.baseRpc,
      "--bridge",
      cfg.bridgeAddress,
      "--deposit",
      args.baseTxHash,
      "--out",
      outDir,
    ],
    { cwd: cfg.proverDir, stdio: "inherit" },
  );
  const seal = readFileSync(join(outDir, "seal.bin"));
  const journal = readFileSync(join(outDir, "journal.bin"));
  const { blockNumber, blockHash } = parseJournalBlock(journal);

  // 2. Wait for Base finality to reach the proven block (a pure block-number check).
  for (;;) {
    const finalized = Number(
      execFileSync(cfg.castBin, ["block", "finalized", "--field", "number", "--rpc-url", cfg.baseRpc], {
        encoding: "utf8",
      }).trim(),
    );
    if (finalized >= blockNumber) break;
    await sleep(15_000);
  }

  // 3. Attest the block hash, then mint via `shield_from_base` (sponsor-signed).
  const net = ["--rpc-url", cfg.stellar.rpcUrl, "--network-passphrase", cfg.stellar.networkPassphrase];
  const invoke = (fnArgs: string[]) =>
    execFileSync(
      "stellar",
      ["contract", "invoke", "--id", args.contractId, "--source-account", cfg.stellar.sponsorSecret, ...net, "--send", "yes", "--", ...fnArgs],
      { encoding: "utf8" },
    );
  invoke(["attest_base_block", "--block_number", String(blockNumber), "--block_hash", blockHash]);
  const sealPath = join(outDir, "seal.bin");
  const journalPath = join(outDir, "journal.bin");
  const out = invoke([
    "shield_from_base",
    "--seal-file-path",
    sealPath,
    "--journal-file-path",
    journalPath,
  ]);
  void seal; // read above to fail fast if the prover output is missing
  const txHash = out.trim().split(/\s+/).pop() ?? "";
  return { owner_tag: args.owner_tag, txHash };
}
