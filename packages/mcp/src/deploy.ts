import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import {
  BASE_SEPOLIA_CONFIG_ID,
  DEFAULT_BASE_SEPOLIA_ROUTER_ID,
  FriendbotFunder,
  type AssetDef,
  type Desk,
  type NetworkConfig,
  type PairDef,
} from "@mosaic/sdk";
import { loadMosaicBridge, loadProtocolRelease } from "@mosaic/sdk/assets/node";
import { StellarCliDeployer } from "@mosaic/sdk/node";
import { createPublicClient, http, type Abi, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import type { DeployHandlers } from "./server.js";
import type { MosaicStore } from "./store.js";

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
  private readonly store?: MosaicStore;
  private readonly baseRpc?: string;
  private readonly baseRouterId: string;

  constructor(opts: { network?: NetworkConfig; stellarBin?: string; store?: MosaicStore; baseRpc?: string; baseRouterId?: string } = {}) {
    this.network = opts.network ?? networkFromEnv();
    this.stellarBin = opts.stellarBin ?? process.env.MOSAIC_STELLAR_BIN;
    this.store = opts.store;
    this.baseRpc = opts.baseRpc ?? process.env.MOSAIC_BASE_RPC;
    this.baseRouterId = opts.baseRouterId ?? process.env.MOSAIC_BASE_ROUTER_ID ?? DEFAULT_BASE_SEPOLIA_ROUTER_ID;
  }

  async createDesk(body: Record<string, unknown>): Promise<{ desk: Desk; sponsorSecret?: string | null }> {
    const sponsor = Keypair.random();
    if (this.network.friendbotUrl) await new FriendbotFunder(this.network.friendbotUrl).fund(sponsor.publicKey());
    const startLedger = await this.latestLedger();
    const assets = assetsFromBody(body);
    const pairs = pairsFromBody(body);
    const requestedBase = body.base_deployment as { deployer_address?: unknown; assets?: unknown } | undefined;
    const baseAssets = Array.isArray(requestedBase?.assets)
      ? requestedBase.assets.map((raw) => {
          const asset = raw as { asset_id?: unknown; symbol?: unknown; token?: unknown };
          return { asset_id: Number(asset.asset_id), symbol: String(asset.symbol ?? ""), token: String(asset.token ?? "") };
        })
      : assets
          .filter((asset) => asset.kind === "Dual" || asset.kind === "BaseRepresented")
          .map((asset) => ({ asset_id: asset.asset_id, symbol: asset.symbol, token: asset.token ?? "represented" }));
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
            deployer_address: String(requestedBase?.deployer_address ?? ""),
            tx_hash: null,
            bridge_address: null,
            error: null,
            assets: baseAssets,
          }
        : null,
    };
    return { desk, sponsorSecret: sponsor.secret() };
  }

  async completeBaseDeployment(id: string, body: Record<string, unknown>, _address: string): Promise<Desk> {
    if (!this.store) throw new Error("MCP store is not configured");
    if (!this.baseRpc) throw new Error("Base deployment completion is not configured on this MCP server");
    const desk = await this.store.getDesk(id);
    const setup = desk.base_deployment;
    if (!setup) throw new Error("desk was not created with Base deployment enabled");
    const txHash = String(body.tx_hash ?? "");
    const bridgeAddress = String(body.bridge_address ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("invalid Base deployment tx hash");
    if (!/^0x[0-9a-fA-F]{40}$/.test(bridgeAddress)) throw new Error("invalid Base bridge address");

    const artifact = (await loadMosaicBridge()) as { abi: Abi; deployedBytecode?: { object?: string } | string };
    const client = createPublicClient({ chain: baseSepolia, transport: http(this.baseRpc) });
    const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
    if (receipt.status !== "success") throw new Error("Base deployment transaction did not succeed");
    const code = await client.getCode({ address: bridgeAddress as Address });
    if (!code || code === "0x") throw new Error("Base bridge has no code");
    const expectedCode = typeof artifact.deployedBytecode === "string" ? artifact.deployedBytecode : artifact.deployedBytecode?.object;
    if (expectedCode && code.toLowerCase() !== expectedCode.toLowerCase()) throw new Error("Base bridge bytecode does not match MosaicBridge");
    const owner = (await client.readContract({ address: bridgeAddress as Address, abi: artifact.abi, functionName: "owner" })) as string;
    if (owner.toLowerCase() !== setup.deployer_address.toLowerCase()) throw new Error("Base bridge owner does not match deployer");
    for (const asset of setup.assets) {
      const token = (await client.readContract({
        address: bridgeAddress as Address,
        abi: artifact.abi,
        functionName: "assetToken",
        args: [asset.asset_id],
      })) as string;
      if (token.toLowerCase() !== asset.token.toLowerCase()) throw new Error(`Base bridge asset ${asset.asset_id} is mapped to ${token}`);
    }

    const sponsor = await this.store.sponsorSecret(id);
    if (!sponsor) throw new Error("desk has no sponsor key");
    const release = await loadProtocolRelease();
    if (!release.bridge_image_id) throw new Error("protocol release is missing bridge_image_id");
    this.configureBaseBridge(desk.contract_id, sponsor, bridgeAddress, release.bridge_image_id);
    const updated: Desk = {
      ...desk,
      base_deployment: {
        ...setup,
        status: "active",
        tx_hash: txHash,
        bridge_address: bridgeAddress,
        error: null,
      },
    };
    return this.store.insertDesk(updated, null);
  }

  async baseDeploymentConfig(): Promise<unknown> {
    if (!this.baseRpc) return { available: false, chain_id: 84532, network: "base-sepolia", reason: "base_deploy_not_configured", abi: null, bytecode: null };
    const [artifact, release] = await Promise.all([loadMosaicBridge(), loadProtocolRelease()]);
    const bridge = artifact as { abi: Abi; bytecode?: { object?: string } | string };
    const bytecode = typeof bridge.bytecode === "string" ? bridge.bytecode : bridge.bytecode?.object ?? null;
    return {
      available: true,
      chain_id: 84532,
      network: "base-sepolia",
      reason: null,
      abi: bridge.abi,
      bytecode,
      router_id: this.baseRouterId,
      image_id: release.bridge_image_id ?? null,
      config_id: BASE_SEPOLIA_CONFIG_ID,
    };
  }

  private async latestLedger(): Promise<number | null> {
    try {
      return (await new rpc.Server(this.network.rpcUrl).getLatestLedger()).sequence;
    } catch {
      return null;
    }
  }

  private configureBaseBridge(contractId: string, sponsorSecret: string, bridgeAddress: string, imageId: string): void {
    const net = ["--rpc-url", this.network.rpcUrl, "--network-passphrase", this.network.networkPassphrase];
    execFileSync(
      this.stellarBin ?? "stellar",
      [
        "contract",
        "invoke",
        "--id",
        contractId,
        "--source-account",
        sponsorSecret,
        ...net,
        "--send",
        "yes",
        "--",
        "configure_base_bridge",
        "--router",
        this.baseRouterId,
        "--image_id",
        imageId,
        "--config_id",
        BASE_SEPOLIA_CONFIG_ID,
        "--bridge",
        bridgeAddress.replace(/^0x/i, ""),
      ],
      { encoding: "utf8" },
    );
  }
}
