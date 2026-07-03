// Mosaic wiring for one agent: a fully-local Node MosaicClient (WASM proving, SQLite note store
// under .demo/) with a pure-RPC deployer so `mosaic_create_desk` needs no `stellar` CLI. The
// startLedger is captured at process boot — before any desk exists — so both agents can replay the
// new desk's note-tree events from scratch (same trick as packages/cli).

import { join } from "node:path";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { SecretKeySigner, StellarRpcDeployer, type AssetDef, type PairDef } from "@mosaic/sdk";
import { createNodeClient, type NodeClient } from "@mosaic/sdk/node";
import { loadSettlementWasm, loadVk } from "@mosaic/sdk/assets/node";
import { DEMO_DIR, NETWORK, type AgentConfig } from "./config.js";

/** The demo desk's immutable asset/pair set. Canonical pair 0 = XLM/USDC (base/quote). */
export const XLM_ASSET_ID = 1;
export const USDC_ASSET_ID = 2;
export function deskSpec(usdcIssuer: string): { assets: AssetDef[]; pairs: Omit<PairDef, "pair_id">[] } {
  return {
    assets: [
      { asset_id: XLM_ASSET_ID, symbol: "XLM", token: "native", decimals: 7, kind: "Stellar" },
      { asset_id: USDC_ASSET_ID, symbol: "USDC", token: `USDC:${usdcIssuer}`, decimals: 7, kind: "Stellar" },
    ],
    pairs: [{ base_asset: XLM_ASSET_ID, quote_asset: USDC_ASSET_ID }],
  };
}

export interface MosaicSession extends NodeClient {
  /** The agent's own Stellar address (unshield recipient). */
  address: string;
}

export async function buildMosaic(cfg: AgentConfig): Promise<MosaicSession> {
  const startLedger = (await new rpc.Server(NETWORK.rpcUrl).getLatestLedger()).sequence;
  const deployer = new StellarRpcDeployer({
    network: NETWORK,
    signer: new SecretKeySigner(cfg.stellarSecret),
    loadSettlementWasm,
    loadVk,
  });
  const node = createNodeClient({
    network: NETWORK,
    secretKey: cfg.stellarSecret,
    dbPath: join(DEMO_DIR, `${cfg.name}-notes.db`),
    startLedger,
    deployer,
  });
  return { ...node, address: Keypair.fromSecret(cfg.stellarSecret).publicKey() };
}
