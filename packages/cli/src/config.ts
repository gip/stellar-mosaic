// CLI state: the active key, known desks, and network coordinates, persisted as JSON under
// $MOSAIC_HOME (default ~/.mosaic). Notes live in a sibling SQLite db.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Networks } from "@stellar/stellar-sdk";
import type { DeskConfig, NetworkConfig } from "@mosaic/sdk";

export interface CliConfig {
  network: NetworkConfig;
  /** Stellar secret seed (S...) used to sign + pay. */
  secretKey?: string;
  desks: DeskConfig[];
  /** First ledger to read note-tree events from (stamped at deploy/import). */
  startLedger?: number;
}

export const HOME = process.env.MOSAIC_HOME ?? join(homedir(), ".mosaic");
const CONFIG_PATH = join(HOME, "config.json");

export function dbPath(): string {
  return join(HOME, "notes.db");
}

function defaults(): CliConfig {
  return {
    network: {
      rpcUrl: process.env.MOSAIC_RPC ?? "https://soroban-testnet.stellar.org",
      networkPassphrase: process.env.MOSAIC_NETWORK_PASSPHRASE ?? Networks.TESTNET,
      friendbotUrl: process.env.MOSAIC_FRIENDBOT ?? "https://friendbot.stellar.org",
    },
    desks: [],
  };
}

export function load(): CliConfig {
  if (!existsSync(CONFIG_PATH)) return defaults();
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<CliConfig>;
  return { ...defaults(), ...parsed, network: { ...defaults().network, ...parsed.network } };
}

export function save(config: CliConfig): void {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export function requireKey(config: CliConfig): string {
  if (!config.secretKey) {
    throw new Error("No key configured. Run `mosaic keys generate` (then `mosaic fund`).");
  }
  return config.secretKey;
}
