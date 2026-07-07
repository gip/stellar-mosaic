// The resolved runtime context one agent process runs with: derived identity, backend-served
// config, provider key from env, network endpoints, and the desk spec built from the config's
// asset/pair universe (same id-assignment rules as the agents/ experiment runner).

import type { DeskConfig } from "@mosaic/sdk";
import type { AgentIdentity } from "../derive.js";
import type { AgentConfig } from "../types.js";

export const DEFAULT_NETWORK = {
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  friendbotUrl: "https://friendbot.stellar.org",
};

/** The desk's immutable asset/pair set, in the shape `client.deploy` takes (pair ids are assigned
 *  on deploy). */
export interface DeskSpec {
  assets: DeskConfig["assets"];
  pairs: Omit<DeskConfig["pairs"][number], "pair_id">[];
}

/** Asset ids by declaration order starting at 1; no issuer = the native lumen; everything is a
 *  7-decimal classic Stellar asset. Pair orientation is canonical (base/quote) as declared. */
export function buildDeskSpec(desk: NonNullable<AgentConfig["desk"]>): DeskSpec {
  const idBySymbol = new Map(desk.assets.map((a, i) => [a.symbol, i + 1]));
  for (const pair of desk.pairs) {
    if (!idBySymbol.has(pair.base) || !idBySymbol.has(pair.quote)) {
      throw new Error(`desk pair ${pair.base}/${pair.quote} references an undeclared asset`);
    }
  }
  return {
    assets: desk.assets.map((a, i) => ({
      asset_id: i + 1,
      symbol: a.symbol,
      token: a.issuer ? `${a.symbol}:${a.issuer}` : "native",
      decimals: 7,
      kind: "Stellar",
    })),
    pairs: desk.pairs.map((p) => ({ base_asset: idBySymbol.get(p.base)!, quote_asset: idBySymbol.get(p.quote)! })),
  };
}

export interface RuntimeContext {
  identity: AgentIdentity;
  /** Display name (the registered descriptor name, or the stellar key prefix). */
  name: string;
  config: AgentConfig;
  desk: DeskSpec;
  mandate: string;
  apiKey: string;
  backendUrl: string;
  /** Per-agent working directory (XMTP db, note store). */
  dataDir: string;
  network: { horizonUrl: string; rpcUrl: string; networkPassphrase: string; friendbotUrl?: string };
  xmtpEnv: "dev" | "production" | "local";
  log: (line: string) => void;
}
