import { randomUUID } from "node:crypto";
import { Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { FriendbotFunder, type AssetDef, type Desk, type NetworkConfig, type PairDef } from "@mosaic/sdk";
import { StellarCliDeployer } from "@mosaic/sdk/node";
import type { DeployHandlers } from "./server.js";

type CreateDeskAsset = {
  asset_id: number;
  symbol: string;
  token: string;
  decimals?: number;
  kind?: AssetDef["kind"];
};

type CreateDeskPair = {
  base_asset: number;
  quote_asset: number;
};

function networkFromEnv(): NetworkConfig {
  return {
    rpcUrl: process.env.MOSAIC_RPC ?? "https://soroban-testnet.stellar.org",
    networkPassphrase: process.env.MOSAIC_NETWORK_PASSPHRASE ?? Networks.TESTNET,
    friendbotUrl: process.env.MOSAIC_FRIENDBOT_URL ?? "https://friendbot.stellar.org",
  };
}

function assetsFromBody(body: Record<string, unknown>): AssetDef[] {
  const assets = body.assets;
  if (!Array.isArray(assets) || assets.length === 0) throw new Error("at least one asset required");
  return assets.map((raw) => {
    const asset = raw as Partial<CreateDeskAsset>;
    const kind = asset.kind ?? "Stellar";
    return {
      asset_id: Number(asset.asset_id),
      symbol: String(asset.symbol ?? ""),
      token: kind === "BaseRepresented" ? null : String(asset.token ?? "native"),
      decimals: Number(asset.decimals ?? 7),
      kind,
    };
  });
}

function pairsFromBody(body: Record<string, unknown>): Omit<PairDef, "pair_id">[] {
  const pairs = body.pairs;
  if (!Array.isArray(pairs)) return [];
  return pairs.map((raw) => {
    const pair = raw as Partial<CreateDeskPair>;
    return { base_asset: Number(pair.base_asset), quote_asset: Number(pair.quote_asset) };
  });
}

export class SponsoredStellarDeployHandlers implements DeployHandlers {
  private readonly network: NetworkConfig;
  private readonly stellarBin?: string;

  constructor(opts: { network?: NetworkConfig; stellarBin?: string } = {}) {
    this.network = opts.network ?? networkFromEnv();
    this.stellarBin = opts.stellarBin ?? process.env.MOSAIC_STELLAR_BIN;
  }

  async createDesk(body: Record<string, unknown>): Promise<{ desk: Desk; sponsorSecret?: string | null }> {
    const sponsor = Keypair.random();
    if (this.network.friendbotUrl) await new FriendbotFunder(this.network.friendbotUrl).fund(sponsor.publicKey());
    const startLedger = await this.latestLedger();
    const assets = assetsFromBody(body);
    const pairs = pairsFromBody(body);
    const deployer = new StellarCliDeployer({
      network: this.network,
      source: sponsor.secret(),
      stellarBin: this.stellarBin,
    });
    const { contractId } = await deployer.deploySettlement({
      assets,
      pairs,
      admin: sponsor.publicKey(),
    });
    const desk: Desk = {
      id: randomUUID(),
      name: String(body.name ?? "Mosaic desk"),
      contract_id: contractId,
      sponsor_pubkey: sponsor.publicKey(),
      event_start_ledger: startLedger,
      assets: assets.map((asset) => ({ ...asset, token: asset.token ?? "represented" })),
      pairs: pairs.map((pair, pair_id) => ({ ...pair, pair_id })),
      base_deployment: body.base_deployment
        ? {
            status: "awaiting_wallet",
            deployer_address: String((body.base_deployment as { deployer_address?: unknown }).deployer_address ?? ""),
            tx_hash: null,
            bridge_address: null,
            error: null,
            assets: assets
              .filter((asset) => asset.kind === "Dual" || asset.kind === "BaseRepresented")
              .map((asset) => ({ asset_id: asset.asset_id, symbol: asset.symbol, token: asset.token ?? "represented" })),
          }
        : null,
    };
    return { desk, sponsorSecret: sponsor.secret() };
  }

  async completeBaseDeployment(_id: string, _body: Record<string, unknown>, _address: string): Promise<Desk> {
    throw new Error("Base deployment completion is not configured on this MCP server");
  }

  async baseDeploymentConfig(): Promise<unknown> {
    return { available: false, reason: "base_deploy_not_configured" };
  }

  private async latestLedger(): Promise<number | null> {
    try {
      return (await new rpc.Server(this.network.rpcUrl).getLatestLedger()).sequence;
    } catch {
      return null;
    }
  }
}
