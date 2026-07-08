import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import {
  BASE_SEPOLIA_CONFIG_ID,
  CREATE2_PROXY,
  DEFAULT_BASE_SEPOLIA_ROUTER_ID,
  FriendbotFunder,
  buildBridgeDeployment,
  type ActivityEvent,
  type AssetDef,
  type Desk,
  type MosaicBridgeArtifact,
  type NetworkConfig,
  type PairDef,
} from "@mosaic/sdk";
import { loadMosaicBridge, loadProtocolRelease } from "@mosaic/sdk/assets/node";
import { StellarCliDeployer } from "@mosaic/sdk/node";
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import type { DeployHandlers } from "./server.js";
import type { MosaicStore } from "./store.js";

type BaseAssetMapping = { asset_id: number; symbol: string; token: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Stellar transaction hash as the CLI logs it to stderr (64 lowercase hex chars). */
const STELLAR_TX_HASH = /\b[0-9a-f]{64}\b/g;

/** sha256 of the lowercased runtime-bytecode hex of earlier released MosaicBridge builds. An
 * in-flight trustless deploy signed against an old artifact must stay completable after the server
 * upgrades — the exact-bytecode check below otherwise strands it permanently. All artifacts before
 * desk permissioning shipped one runtime bytecode; such bridges are inherently open. */
const LEGACY_BRIDGE_CODE_SHA256 = new Set([
  "adec1a0da7b333f8c37fd3381f4eacd3a6b8355cfff95b3fe28226ff7b2a4241",
]);

/** Accept a 0x-prefixed or bare 32-byte hex private key. */
function normalizePrivateKey(key: string): Hex {
  const hex = key.startsWith("0x") ? key : `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("MOSAIC_BASE_DEPLOYER_KEY must be a 32-byte hex private key");
  return hex as Hex;
}

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

const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Optional desk permissioning from the create-desk body: the flag plus the initial Stellar (G…)
 * and Base (0x…) allowlists. Members are only legal on a permissioned desk. */
function permissioningFromBody(body: Record<string, unknown>): {
  permissioned: boolean;
  allowlist: string[];
  baseAllowlist: string[];
} {
  // Strict boolean: the mode is immutable, so a truthy non-boolean (e.g. the string "true")
  // silently deploying a permanently open desk is the worst possible coercion.
  if (body.permissioned != null && typeof body.permissioned !== "boolean") {
    throw new Error("permissioned must be a boolean");
  }
  const permissioned = body.permissioned === true;
  const readList = (value: unknown, pattern: RegExp, label: string): string[] => {
    if (value == null) return [];
    if (!Array.isArray(value)) throw new Error(`${label} must be an array of addresses`);
    return value.map((entry) => {
      const address = String(entry).trim();
      if (!pattern.test(address)) throw new Error(`invalid ${label} entry: ${address}`);
      return address;
    });
  };
  const allowlist = readList(body.allowlist, STELLAR_ADDRESS, "allowlist");
  const baseAllowlist = readList(body.base_allowlist, EVM_ADDRESS, "base_allowlist");
  if (!permissioned && (allowlist.length > 0 || baseAllowlist.length > 0)) {
    throw new Error("an initial allowlist requires a permissioned desk");
  }
  return { permissioned, allowlist, baseAllowlist };
}

/** Base-side asset→token mappings the server should register on the bridge. The caller (the
 * frontend / CLI) supplies the Base token addresses, which the Stellar asset defs do not carry.
 * Accepts the new `base_assets` shape or the legacy `base_deployment.assets` shape. */
function baseAssetsFromBody(body: Record<string, unknown>): BaseAssetMapping[] {
  const legacy = (body.base_deployment as { assets?: unknown } | undefined)?.assets;
  const raw = Array.isArray(body.base_assets) ? body.base_assets : Array.isArray(legacy) ? legacy : [];
  return raw.map((entry) => {
    const asset = entry as { asset_id?: unknown; symbol?: unknown; token?: unknown };
    return { asset_id: Number(asset.asset_id), symbol: String(asset.symbol ?? ""), token: String(asset.token ?? "") };
  });
}

export class SponsoredStellarDeployHandlers implements DeployHandlers {
  private readonly network: NetworkConfig;
  private readonly stellarBin?: string;
  private readonly store?: MosaicStore;
  private readonly baseRpc?: string;
  private readonly baseRouterId: string;
  /** Operator-funded Base Sepolia key that deploys and owns bridges in Trusted mode. */
  private readonly baseDeployerKey?: string;

  constructor(
    opts: {
      network?: NetworkConfig;
      stellarBin?: string;
      store?: MosaicStore;
      baseRpc?: string;
      baseRouterId?: string;
      baseDeployerKey?: string;
    } = {},
  ) {
    this.network = opts.network ?? networkFromEnv();
    this.stellarBin = opts.stellarBin ?? process.env.MOSAIC_STELLAR_BIN;
    this.store = opts.store;
    this.baseRpc = opts.baseRpc ?? process.env.MOSAIC_BASE_RPC;
    this.baseRouterId = opts.baseRouterId ?? process.env.MOSAIC_BASE_ROUTER_ID ?? DEFAULT_BASE_SEPOLIA_ROUTER_ID;
    this.baseDeployerKey = opts.baseDeployerKey ?? process.env.MOSAIC_BASE_DEPLOYER_KEY;
  }

  /** Whether this server can deploy Base bridges itself (has an RPC and a funded deployer key). */
  private get canDeployBase(): boolean {
    return !!this.baseRpc && !!this.baseDeployerKey;
  }

  async createDesk(
    body: Record<string, unknown>,
    creator?: string,
    network?: string,
  ): Promise<{ desk: Desk; sponsorSecret?: string | null }> {
    const assets = assetsFromBody(body);
    const pairs = pairsFromBody(body);
    const baseAssets = baseAssetsFromBody(body);
    const { permissioned, allowlist, baseAllowlist } = permissioningFromBody(body);
    // Trusted mode: the on-chain admin is the server-held sponsor key, not the creator — without
    // this seed the creator deploys a desk they themselves cannot shield into or unshield from.
    // `include_creator: false` is an explicit client opt-out (the create-desk form's checkbox).
    if (permissioned && body.include_creator !== false && creator && STELLAR_ADDRESS.test(creator) && !allowlist.includes(creator)) {
      allowlist.unshift(creator);
    }
    // Fail fast, before funding a sponsor and deploying the Stellar contract: if the desk needs a
    // bridge this server cannot build, there is no point creating half a desk.
    if (baseAssets.length > 0 && !this.canDeployBase) {
      throw new Error(
        "This desk needs a Base Sepolia bridge, but Base deployment is not configured on this MCP server " +
          "(set MOSAIC_BASE_RPC and MOSAIC_BASE_DEPLOYER_KEY).",
      );
    }
    const name = String(body.name ?? "Mosaic desk");
    const deskId = randomUUID();
    const actionId = randomUUID();
    // Trusted mode records deploy activity server-side (the browser used to, but without tx hashes);
    // the creator's wallet pulls it via `activity_since`. Best-effort — never fail a deploy on logging.
    const record = (event: Partial<ActivityEvent> & Pick<ActivityEvent, "kind">) =>
      this.recordDeployActivity(creator, network, {
        ...event,
        desk_id: deskId,
        metadata: { action_id: actionId, name, ...(event.metadata ?? {}) },
      });

    const sponsor = Keypair.random();
    if (this.network.friendbotUrl) await new FriendbotFunder(this.network.friendbotUrl).fund(sponsor.publicKey());
    const startLedger = await this.latestLedger();
    await record({ kind: "user_action", action: "create_desk", status: "started", metadata: { asset_count: assets.length, pair_count: pairs.length } });
    const deployer = new StellarCliDeployer({ network: this.network, source: sponsor.secret(), stellarBin: this.stellarBin });
    const { contractId, txHash: stellarTx } = await deployer.deploySettlement({
      assets,
      pairs,
      admin: sponsor.publicKey(),
      allowlist: permissioned ? allowlist : undefined,
    });
    await record({
      kind: "user_action", action: "create_desk", status: "succeeded", contract_id: contractId, tx_hash: stellarTx,
      metadata: { asset_count: assets.length, pair_count: pairs.length },
    });

    const desk: Desk = {
      id: deskId,
      name,
      contract_id: contractId,
      sponsor_pubkey: sponsor.publicKey(),
      event_start_ledger: startLedger,
      assets: assets.map((asset) => ({ ...asset, token: asset.token ?? "represented" })),
      pairs: pairs.map((pair, pair_id) => ({ ...pair, pair_id })),
      base_deployment: null,
      permissioned,
      creator_address: creator ?? null,
    };

    if (baseAssets.length > 0) {
      const requireFinality = body.require_finality === true;
      desk.base_deployment = await this.deployAndConfigureBase(
        desk,
        sponsor.secret(),
        baseAssets,
        record,
        requireFinality,
        permissioned,
        baseAllowlist,
      );
    }
    return { desk, sponsorSecret: sponsor.secret() };
  }

  /** Deploy the bridge on Base with the operator key, configure it on the Stellar desk, and record
   * activity. On failure, returns a `failed` deployment (the Stellar desk still exists) so the UI can
   * surface it and offer a server-side retry rather than losing the deploy. */
  private async deployAndConfigureBase(
    desk: Desk,
    sponsorSecret: string,
    baseAssets: BaseAssetMapping[],
    record: (event: Partial<ActivityEvent> & Pick<ActivityEvent, "kind">) => Promise<void>,
    requireFinality = false,
    permissioned = false,
    initialAllowed: string[] = [],
  ): Promise<Desk["base_deployment"]> {
    const deployerAddress = privateKeyToAccount(normalizePrivateKey(this.baseDeployerKey!)).address;
    const base: NonNullable<Desk["base_deployment"]> = {
      status: "verifying",
      deployer_address: deployerAddress,
      tx_hash: null,
      bridge_address: null,
      error: null,
      assets: baseAssets,
      require_finality: requireFinality,
      // Persist the seed so a failed deploy can be retried with the same allowlist.
      ...(permissioned && initialAllowed.length > 0 ? { allowlist: initialAllowed } : {}),
    };
    try {
      const deployed = await this.deployBridgeOnBase(baseAssets, permissioned, initialAllowed);
      base.tx_hash = deployed.txHash;
      base.bridge_address = deployed.bridgeAddress;
      await record({
        kind: "user_action", action: "deploy_base_bridge", status: "succeeded", contract_id: desk.contract_id,
        tx_hash: deployed.txHash, metadata: { bridge_address: deployed.bridgeAddress },
      });
      const release = await loadProtocolRelease();
      if (!release.bridge_image_id) throw new Error("protocol release is missing bridge_image_id");
      const configureTx = this.configureBaseBridge(desk.contract_id, sponsorSecret, deployed.bridgeAddress, release.bridge_image_id);
      await record({
        kind: "user_action", action: "configure_base_bridge", status: "succeeded", contract_id: desk.contract_id,
        tx_hash: configureTx, metadata: { bridge_address: deployed.bridgeAddress },
      });
      base.status = "active";
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      base.status = "failed";
      base.error = message;
      await record({
        kind: "error", action: "deploy_base_bridge", status: "failed", contract_id: desk.contract_id,
        message, idempotency_key: randomUUID(),
      });
    }
    return base;
  }

  /** Deploy a MosaicBridge on Base Sepolia via the CREATE2 proxy, signed and paid by the operator key. */
  private async deployBridgeOnBase(
    baseAssets: BaseAssetMapping[],
    permissioned = false,
    initialAllowed: string[] = [],
  ): Promise<{ txHash: string; bridgeAddress: string; deployer: string }> {
    if (!this.baseRpc || !this.baseDeployerKey) throw new Error("Base deployment is not configured on this MCP server");
    const artifact = (await loadMosaicBridge()) as MosaicBridgeArtifact;
    const account = privateKeyToAccount(normalizePrivateKey(this.baseDeployerKey));
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(this.baseRpc) });
    const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(this.baseRpc) });
    const proxyCode = await publicClient.getCode({ address: CREATE2_PROXY });
    if (!proxyCode || proxyCode === "0x") throw new Error("The CREATE2 deployment proxy is not present on Base Sepolia.");
    const call = buildBridgeDeployment(
      artifact,
      account.address,
      baseAssets.map((asset) => asset.asset_id),
      baseAssets.map((asset) => asset.token),
      permissioned,
      initialAllowed,
    );
    const txHash = await walletClient.sendTransaction({ to: CREATE2_PROXY, data: call.data });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`The Base bridge deployment transaction reverted (${txHash}).`);
    // `call.bridgeAddress` is the deterministic CREATE2 result of a fresh random salt, so a successful
    // receipt guarantees code will exist there. Code can lag a confirmed receipt on load-balanced
    // RPCs; poll to smooth that, but never discard a confirmed deploy over read-replica lag —
    // configuring the Stellar side against the (real) bridge address is the authoritative next step.
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const code = await publicClient.getCode({ address: call.bridgeAddress });
      if (code && code !== "0x") break;
      await sleep(1500);
    }
    return { txHash, bridgeAddress: call.bridgeAddress, deployer: account.address };
  }

  private async recordDeployActivity(
    address: string | undefined,
    network: string | undefined,
    event: Partial<ActivityEvent> & Pick<ActivityEvent, "kind">,
  ): Promise<void> {
    if (!this.store || !address) return;
    try {
      await this.store.recordActivity(address, network ?? "testnet", [{ wallet_address: address, network, ...event } as ActivityEvent]);
    } catch {
      /* Activity is best-effort UI state; the on-chain deploy is authoritative. */
    }
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
    const isCurrentCode = !expectedCode || code.toLowerCase() === expectedCode.toLowerCase();
    const isLegacyCode =
      !isCurrentCode &&
      LEGACY_BRIDGE_CODE_SHA256.has(createHash("sha256").update(code.toLowerCase()).digest("hex"));
    if (!isCurrentCode && !isLegacyCode) throw new Error("Base bridge bytecode does not match MosaicBridge");
    const owner = (await client.readContract({ address: bridgeAddress as Address, abi: artifact.abi, functionName: "owner" })) as string;
    if (owner.toLowerCase() !== setup.deployer_address.toLowerCase()) throw new Error("Base bridge owner does not match deployer");
    if (isLegacyCode) {
      // Pre-permissioning bridges have no `permissioned()`/allowlist and are inherently open.
      if (desk.permissioned === true) throw new Error("a permissioned desk cannot use a pre-permissioning Base bridge");
    } else {
      const bridgePermissioned = (await client.readContract({
        address: bridgeAddress as Address,
        abi: artifact.abi,
        functionName: "permissioned",
      })) as boolean;
      if (bridgePermissioned !== (desk.permissioned === true)) {
        throw new Error("Base bridge permissioned flag does not match the desk");
      }
    }
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

  /** Re-run the server-side Base deploy + configure for a desk whose bridge is not yet active. Used
   * by the UI's retry affordance when the first attempt failed (e.g. transient RPC / gas). */
  async retryBaseDeployment(id: string, address?: string, network?: string): Promise<Desk> {
    if (!this.store) throw new Error("MCP store is not configured");
    if (!this.canDeployBase) throw new Error("Base deployment is not configured on this MCP server");
    const desk = await this.store.getDesk(id);
    const setup = desk.base_deployment;
    if (!setup) throw new Error("desk was not created with a Base bridge");
    if (setup.status === "active") return desk;
    const sponsor = await this.store.sponsorSecret(id);
    if (!sponsor) throw new Error("desk has no sponsor key");
    const actionId = randomUUID();
    const record = (event: Partial<ActivityEvent> & Pick<ActivityEvent, "kind">) =>
      this.recordDeployActivity(address, network, {
        ...event,
        desk_id: desk.id,
        metadata: { action_id: actionId, name: desk.name, ...(event.metadata ?? {}) },
      });
    const base_deployment = await this.deployAndConfigureBase(
      desk,
      sponsor,
      setup.assets,
      record,
      setup.require_finality ?? false,
      desk.permissioned === true,
      setup.allowlist ?? [],
    );
    return this.store.insertDesk({ ...desk, base_deployment }, null);
  }

  async baseDeploymentConfig(): Promise<unknown> {
    if (!this.baseRpc) {
      return { available: false, server_deploys: false, chain_id: 84532, network: "base-sepolia", reason: "base_deploy_not_configured", abi: null, bytecode: null };
    }
    const [artifact, release] = await Promise.all([loadMosaicBridge(), loadProtocolRelease()]);
    const bridge = artifact as { abi: Abi; bytecode?: { object?: string } | string };
    const bytecode = typeof bridge.bytecode === "string" ? bridge.bytecode : bridge.bytecode?.object ?? null;
    return {
      available: true,
      // In Trusted mode the server owns a funded deployer key and deploys the bridge itself; the
      // browser never needs to sign. Advertised so the frontend can skip the MetaMask flow.
      server_deploys: this.canDeployBase,
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

  /** Add members to a permissioned desk's on-chain allowlists. Only the desk creator's session may
   * call this (Trusted mode: the server holds the Stellar admin sponsor key and the Base bridge
   * owner key, so on-chain auth alone would not restrain other authenticated users). Add-only. */
  async addDeskAllowed(
    id: string,
    body: { stellar_members?: string[]; evm_members?: string[] },
    address: string,
    network?: string,
  ): Promise<{ ok: boolean; stellar_tx_hashes: string[]; evm_tx_hashes: string[] }> {
    if (!this.store) throw new Error("MCP store is not configured");
    const desk = await this.store.getDesk(id);
    if (desk.permissioned !== true) throw new Error("this desk is not permissioned");
    if (!desk.creator_address || desk.creator_address !== address) {
      throw new Error("only the desk creator may manage its allowlist");
    }
    const stellarMembers = (body.stellar_members ?? []).map((member) => {
      const value = String(member).trim();
      if (!STELLAR_ADDRESS.test(value)) throw new Error(`invalid Stellar member: ${value}`);
      return value;
    });
    const evmMembers = (body.evm_members ?? []).map((member) => {
      const value = String(member).trim();
      if (!EVM_ADDRESS.test(value)) throw new Error(`invalid Base member: ${value}`);
      return value;
    });
    if (stellarMembers.length === 0 && evmMembers.length === 0) throw new Error("no members to add");

    // One action_id for the whole request so the Stellar and Base legs fold into a single
    // Activity group in the creator's wallet (same convention as `createDesk`). Best-effort.
    const actionId = randomUUID();
    const record = (event: Partial<ActivityEvent> & Pick<ActivityEvent, "kind">) =>
      this.recordDeployActivity(address, network, {
        ...event,
        desk_id: id,
        metadata: { action_id: actionId, name: desk.name, ...(event.metadata ?? {}) },
      });

    // Resolve every precondition for BOTH legs before the first on-chain write, so a request that
    // was never going to fully succeed does not land a partial Stellar-only update.
    let sponsor: string | null = null;
    if (stellarMembers.length > 0) {
      sponsor = await this.store.sponsorSecret(id);
      if (!sponsor) throw new Error("desk has no sponsor key");
    }
    let evm: { bridgeAddress: string; artifact: MosaicBridgeArtifact } | null = null;
    if (evmMembers.length > 0) {
      const bridgeAddress = desk.base_deployment?.bridge_address;
      if (!bridgeAddress || desk.base_deployment?.status !== "active") {
        throw new Error("this desk has no active Base bridge");
      }
      if (!this.baseRpc || !this.baseDeployerKey) throw new Error("Base management is not configured on this MCP server");
      evm = { bridgeAddress, artifact: (await loadMosaicBridge()) as MosaicBridgeArtifact };
    }

    // Both `add_allowed` and `addAllowed` are idempotent, so a partial failure is safely retried
    // with the full member list — but report what already landed so nothing looks lost.
    const stellarTxHashes: string[] = [];
    const evmTxHashes: string[] = [];
    try {
      if (sponsor) {
        for (const member of stellarMembers) {
          const tx = await this.invokeAddAllowed(desk.contract_id, sponsor, member);
          if (tx) stellarTxHashes.push(tx);
          await record({
            kind: "user_action", action: "add_allowed", status: "succeeded",
            contract_id: desk.contract_id, tx_hash: tx, metadata: { member },
          });
        }
      }
      if (evm) {
        const account = privateKeyToAccount(normalizePrivateKey(this.baseDeployerKey!));
        const publicClient = createPublicClient({ chain: baseSepolia, transport: http(this.baseRpc) });
        const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(this.baseRpc) });
        for (const member of evmMembers) {
          const txHash = await walletClient.writeContract({
            address: evm.bridgeAddress as Address,
            abi: evm.artifact.abi as Abi,
            functionName: "addAllowed",
            args: [member as Address],
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
          if (receipt.status !== "success") throw new Error(`addAllowed(${member}) reverted (${txHash})`);
          evmTxHashes.push(txHash);
          await record({
            kind: "user_action", action: "add_allowed", status: "succeeded",
            tx_hash: txHash, metadata: { member, chain: "base", bridge_address: evm.bridgeAddress },
          });
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await record({
        kind: "error", action: "add_allowed", status: "failed", message,
        contract_id: desk.contract_id,
        metadata: { stellar_members: stellarMembers, evm_members: evmMembers },
      });
      const landed =
        stellarTxHashes.length > 0 || evmTxHashes.length > 0
          ? ` Members added before the failure stayed added (adds are idempotent; retry with the full list).` +
            ` Landed tx hashes — stellar: [${stellarTxHashes.join(", ")}], base: [${evmTxHashes.join(", ")}].`
          : "";
      throw new Error(`${message}${landed}`);
    }
    return { ok: true, stellar_tx_hashes: stellarTxHashes, evm_tx_hashes: evmTxHashes };
  }

  /** Invoke `add_allowed` on the desk (sponsor/admin-signed) without blocking the event loop
   * (`spawnSync` would freeze every other MCP session for the duration). Returns the tx hash if
   * the CLI logged one (best-effort, for the explorer link). */
  private invokeAddAllowed(contractId: string, sponsorSecret: string, member: string): Promise<string | undefined> {
    const net = ["--rpc-url", this.network.rpcUrl, "--network-passphrase", this.network.networkPassphrase];
    const args = [
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
      "add_allowed",
      "--member",
      member,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.stellarBin ?? "stellar", args, { timeout: 120_000 });
      let stderr = "";
      child.stdout.on("data", () => {});
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (signal) reject(new Error(`add_allowed(${member}) was killed (${signal}; timeout?)`));
        else if (code !== 0) reject(new Error(`add_allowed failed: ${stderr}`));
        else resolve(stderr.match(STELLAR_TX_HASH)?.pop() ?? undefined);
      });
    });
  }

  private async latestLedger(): Promise<number | null> {
    try {
      return (await new rpc.Server(this.network.rpcUrl).getLatestLedger()).sequence;
    } catch {
      return null;
    }
  }

  /** Invoke `configure_base_bridge` on the desk (sponsor-signed). Returns the tx hash if the CLI
   * logged one (best-effort, for the explorer link). */
  private configureBaseBridge(contractId: string, sponsorSecret: string, bridgeAddress: string, imageId: string): string | undefined {
    const net = ["--rpc-url", this.network.rpcUrl, "--network-passphrase", this.network.networkPassphrase];
    const result = spawnSync(
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
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`configure_base_bridge failed: ${result.stderr ?? ""}`);
    return (result.stderr ?? "").match(STELLAR_TX_HASH)?.pop() ?? undefined;
  }
}
