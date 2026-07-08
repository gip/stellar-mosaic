// Mosaic wiring for one runtime agent, adapted from agents/src/mosaic.ts: a fully-local Node
// MosaicClient (WASM proving, SQLite note store under the agent's data dir) with a pure-RPC
// deployer. startLedger is captured at boot — before any desk exists — so the agent can replay a
// freshly negotiated desk's note-tree events from scratch.

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { rpc } from "@stellar/stellar-sdk";
import { SecretKeySigner, StellarRpcDeployer } from "@mosaic/sdk";
import { createNodeClient, type NodeClient } from "@mosaic/sdk/node";
import { loadSettlementWasm, loadVk } from "@mosaic/sdk/assets/node";
import type { RuntimeContext } from "./context.js";

export interface MosaicSession extends NodeClient {
  /** The agent's own Stellar address (unshield recipient). */
  address: string;
}

export async function buildMosaic(ctx: RuntimeContext): Promise<MosaicSession> {
  mkdirSync(ctx.dataDir, { recursive: true });
  const network = {
    rpcUrl: ctx.network.rpcUrl,
    networkPassphrase: ctx.network.networkPassphrase,
    ...(ctx.network.friendbotUrl ? { friendbotUrl: ctx.network.friendbotUrl } : {}),
  };
  const startLedger = (await new rpc.Server(network.rpcUrl).getLatestLedger()).sequence;
  const deployer = new StellarRpcDeployer({
    network,
    signer: new SecretKeySigner(ctx.identity.stellarSecret),
    loadSettlementWasm,
    loadVk,
  });
  const node = createNodeClient({
    network,
    secretKey: ctx.identity.stellarSecret,
    dbPath: join(ctx.dataDir, "notes.db"),
    startLedger,
    deployer,
  });
  return { ...node, address: ctx.identity.stellarPublicKey };
}
