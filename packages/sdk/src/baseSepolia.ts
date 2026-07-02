import {
  concat,
  createPublicClient,
  createWalletClient,
  custom,
  encodeDeployData,
  getCreate2Address,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import type {
  BaseBridgeDeployResult,
  BaseBridgeDeployer,
  BaseBridgeEstimate,
  BaseBridgeVerifyParams,
  BaseBridgeVerifyResult,
  EthProvider,
} from "./ports.js";

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_NETWORK = "base-sepolia" as const;
export const BASE_SEPOLIA_CONFIG_ID = "3519660d6ecbd34367740f5ca18449cba8b389594f69f177bbf21c46e505c61e";
export const DEFAULT_BASE_SEPOLIA_ROUTER_ID = "CB3ISULTPMQXHUH6BVRO7VQIQE3TTDRGSHWBJ72V7GRO6VF63BMGNWOU";
export const NATIVE_EVM_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const CREATE2_PROXY: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface MosaicBridgeArtifact {
  abi: Abi;
  bytecode: Hex | { object?: string };
  deployedBytecode?: Hex | { object?: string };
}

export interface BaseSepoliaBridgeDeployerOptions {
  provider: EthProvider;
  loadMosaicBridge: () => Promise<MosaicBridgeArtifact>;
  publicClient?: BaseSepoliaClient;
}

type BaseSepoliaClient = {
  estimateGas(args: { account: Address; to: Address; data: Hex }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint }>;
  getCode(args: { address: Address }): Promise<Hex | undefined>;
  waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: "success" | "reverted" }>;
  getTransactionReceipt(args: { hash: Hex }): Promise<{ status: "success" | "reverted" }>;
  readContract(args: { address: Address; abi: Abi; functionName: string; args?: unknown[] }): Promise<unknown>;
};

function bytecodeOf(artifact: MosaicBridgeArtifact): Hex {
  const raw = typeof artifact.bytecode === "string" ? artifact.bytecode : artifact.bytecode.object;
  if (!raw || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error("MosaicBridge artifact is missing deploy bytecode.");
  return raw as Hex;
}

function deployedBytecodeOf(artifact: MosaicBridgeArtifact): Hex | null {
  const raw = typeof artifact.deployedBytecode === "string" ? artifact.deployedBytecode : artifact.deployedBytecode?.object;
  return raw && /^0x[0-9a-fA-F]+$/.test(raw) ? (raw as Hex) : null;
}

function normalizeAddress(value: string, label: string): Address {
  if (!ADDRESS.test(value)) throw new Error(`${label} must be an EVM address.`);
  return value as Address;
}

function randomSalt(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function initCode(artifact: MosaicBridgeArtifact, account: Address, assetIds: number[], tokens: Address[]): Hex {
  return encodeDeployData({
    abi: artifact.abi,
    bytecode: bytecodeOf(artifact),
    args: [account, assetIds, tokens],
  });
}

function validateMappings(assetIds: number[], tokens: string[]): Address[] {
  if (assetIds.length === 0) throw new Error("At least one Base asset mapping is required.");
  if (assetIds.length !== tokens.length) throw new Error("Base asset ids and token addresses must have equal length.");
  for (const id of assetIds) {
    if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff) throw new Error(`Invalid Base asset id ${id}.`);
  }
  return tokens.map((token, index) => normalizeAddress(token, `Base token for asset ${assetIds[index]}`));
}

export function baseTokenAddress(token: string): string {
  return token === "native" ? NATIVE_EVM_SENTINEL : token;
}

export class BaseSepoliaBridgeDeployer implements BaseBridgeDeployer {
  private readonly provider: EthProvider;
  private readonly loadMosaicBridge: () => Promise<MosaicBridgeArtifact>;
  private readonly publicClient?: BaseSepoliaClient;

  constructor(opts: BaseSepoliaBridgeDeployerOptions) {
    this.provider = opts.provider;
    this.loadMosaicBridge = opts.loadMosaicBridge;
    this.publicClient = opts.publicClient;
  }

  private client(): BaseSepoliaClient {
    return this.publicClient ?? createPublicClient({ chain: baseSepolia, transport: custom(this.provider) });
  }

  private wallet(account: Address) {
    return createWalletClient({ account, chain: baseSepolia, transport: custom(this.provider) });
  }

  private async account(): Promise<Address> {
    const accounts = (await this.provider.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts?.[0]) throw new Error("No EVM account authorized.");
    return normalizeAddress(accounts[0], "EVM account");
  }

  private async deploymentCall(assetIds: number[], tokens: string[], account?: string) {
    const artifact = await this.loadMosaicBridge();
    const deployer = account ? normalizeAddress(account, "EVM account") : await this.account();
    const normalizedTokens = validateMappings(assetIds, tokens);
    const salt = randomSalt();
    const creation = initCode(artifact, deployer, assetIds, normalizedTokens);
    const data = concat([salt, creation]);
    return {
      artifact,
      account: deployer,
      assetIds,
      tokens: normalizedTokens,
      data,
      bridgeAddress: getCreate2Address({ from: CREATE2_PROXY, salt, bytecode: creation }),
    };
  }

  private async estimateCall(call: { account: Address; data: Hex }): Promise<BaseBridgeEstimate> {
    const client = this.client();
    const gasEstimate = await client.estimateGas({ account: call.account, to: CREATE2_PROXY, data: call.data });
    const fees = await client.estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? maxFeePerGas;
    if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
      throw new Error("Base Sepolia RPC did not return usable gas fee estimates.");
    }
    const gas = (gasEstimate * 120n) / 100n;
    return { gas, maxFee: gas * maxFeePerGas, maxFeePerGas, maxPriorityFeePerGas };
  }

  async estimate(params: { assetIds: number[]; tokens: string[]; account?: string }): Promise<BaseBridgeEstimate> {
    const call = await this.deploymentCall(params.assetIds, params.tokens, params.account);
    return this.estimateCall(call);
  }

  async deploy(params: { assetIds: number[]; tokens: string[]; account?: string }): Promise<BaseBridgeDeployResult> {
    const call = await this.deploymentCall(params.assetIds, params.tokens, params.account);
    const client = this.client();
    const proxyCode = await client.getCode({ address: CREATE2_PROXY });
    if (!proxyCode || proxyCode === "0x") throw new Error("The CREATE2 deployment proxy is not present on Base Sepolia.");
    const estimate = await this.estimateCall(call);
    const txHash = await this.wallet(call.account).sendTransaction({
      to: CREATE2_PROXY,
      data: call.data,
      gas: estimate.gas,
      maxFeePerGas: estimate.maxFeePerGas,
      maxPriorityFeePerGas: estimate.maxPriorityFeePerGas,
    });
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`The Base bridge deployment transaction reverted (${txHash}).`);
    for (let attempt = 1; attempt <= 8; attempt++) {
      const code = await client.getCode({ address: call.bridgeAddress });
      if (code && code !== "0x") break;
      if (attempt === 8) throw new Error(`No contract code is visible at ${call.bridgeAddress} after deployment ${txHash}.`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return { txHash, bridgeAddress: call.bridgeAddress, deployer: call.account };
  }

  async verify(params: BaseBridgeVerifyParams): Promise<BaseBridgeVerifyResult> {
    const client = this.client();
    const artifact = await this.loadMosaicBridge();
    const bridge = normalizeAddress(params.bridgeAddress, "bridge address");
    const code = await client.getCode({ address: bridge });
    if (!code || code === "0x") return { ok: false, reason: "missing_code" };
    const expectedCode = deployedBytecodeOf(artifact);
    if (expectedCode && code.toLowerCase() !== expectedCode.toLowerCase()) return { ok: false, reason: "wrong_bytecode" };
    if (params.txHash) {
      const receipt = await client.getTransactionReceipt({ hash: params.txHash as Hex });
      if (receipt.status !== "success") return { ok: false, reason: "failed_receipt" };
    }
    const owner = (await client.readContract({ address: bridge, abi: artifact.abi, functionName: "owner" })) as string;
    if (owner.toLowerCase() !== params.deployer.toLowerCase()) return { ok: false, reason: "wrong_owner" };
    for (const asset of params.assets) {
      const token = (await client.readContract({
        address: bridge,
        abi: artifact.abi,
        functionName: "assetToken",
        args: [asset.asset_id],
      })) as string;
      if (token.toLowerCase() !== asset.token.toLowerCase()) return { ok: false, reason: `wrong_asset_${asset.asset_id}` };
    }
    return { ok: true };
  }
}
