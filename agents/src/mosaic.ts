// Mosaic wiring for one agent: a fully-local Node MosaicClient (WASM proving, SQLite note store
// under the run dir) with a pure-RPC deployer so `mosaic_create_desk` needs no `stellar` CLI. The
// startLedger is captured at process boot — before any desk exists — so all agents can replay the
// new desk's note-tree events from scratch (same trick as packages/cli).

import { join } from "node:path";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { SecretKeySigner, StellarRpcDeployer } from "@mosaic/sdk";
import { createNodeClient, type NodeClient } from "@mosaic/sdk/node";
import { loadSettlementWasm, loadVk } from "@mosaic/sdk/assets/node";
import type { DeskSpec, ExperimentPair, ResolvedAgentFile } from "./experiment.js";

/**
 * The experiment desk's immutable asset/pair set, built from the config's declaration order:
 * asset ids start at 1, an asset without an issuer is the native lumen, everything is a 7-decimal
 * classic Stellar asset. Pair orientation is canonical (base/quote) as declared.
 */
export function buildDeskSpec(
  assets: { symbol: string; issuer?: string }[],
  pairs: ExperimentPair[],
): DeskSpec {
  const idBySymbol = new Map(assets.map((a, i) => [a.symbol, i + 1]));
  return {
    assets: assets.map((a, i) => ({
      asset_id: i + 1,
      symbol: a.symbol,
      token: a.issuer ? `${a.symbol}:${a.issuer}` : "native",
      decimals: 7,
      kind: "Stellar",
    })),
    pairs: pairs.map((p) => ({ base_asset: idBySymbol.get(p.base)!, quote_asset: idBySymbol.get(p.quote)! })),
  };
}

export interface MosaicSession extends NodeClient {
  /** The agent's own Stellar address (unshield recipient). */
  address: string;
}

export async function buildMosaic(cfg: ResolvedAgentFile): Promise<MosaicSession> {
  const startLedger = (await new rpc.Server(cfg.network.rpcUrl).getLatestLedger()).sequence;
  const deployer = new StellarRpcDeployer({
    network: cfg.network,
    signer: new SecretKeySigner(cfg.stellarSecret),
    loadSettlementWasm,
    loadVk,
  });
  const node = createNodeClient({
    network: cfg.network,
    secretKey: cfg.stellarSecret,
    dbPath: join(cfg.runDir, `${cfg.name}-notes.db`),
    startLedger,
    deployer,
  });
  return { ...node, address: Keypair.fromSecret(cfg.stellarSecret).publicKey() };
}
