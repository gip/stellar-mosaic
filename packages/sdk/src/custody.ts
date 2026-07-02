// Desk custody totals. Derives, per supported asset, how much value a desk actually holds — the
// total committed on Stellar (the settlement contract's SAC token balance) and on Base (the
// MosaicBridge contract's ERC-20 / native holdings). No aggregate is stored on-chain; both figures
// are read straight from custody with pure view calls (Soroban simulation + EVM `eth_call`), so this
// needs no wallet and works on the public desk view. Base and Stellar share the same raw units (the
// bridge locks `amount` and the note is minted with the same `amount`), so `AssetDef.decimals`
// formats both sides.

import { Address, Asset, BASE_FEE, Contract, TransactionBuilder, rpc, scValToNative } from "@stellar/stellar-sdk";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import type { Abi, Address as EvmAddress } from "viem";
import { NATIVE_EVM_SENTINEL } from "./baseSepolia.js";
import { getMosaicLogger, type MosaicLogger } from "./logging.js";
import type { AssetKind, Amount, Desk } from "./types.js";

const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const satisfies Abi;

/** Resolve a desk asset's `token` field to a Soroban SAC contract id. Accepts a contract id (`C…`),
 * the `native` sentinel (XLM), or `CODE:ISSUER` (a classic asset's SAC). */
export function resolveStellarTokenContractId(token: string, networkPassphrase: string): string {
  if (CONTRACT_ID.test(token)) return token;
  if (token === "native") return Asset.native().contractId(networkPassphrase);
  const [code, issuer] = token.split(":");
  if (code && issuer) return new Asset(code, issuer).contractId(networkPassphrase);
  throw new Error(`unsupported token "${token}"; pass "native", CODE:ISSUER, or a SAC contract id (C...)`);
}

/** Per-asset custody totals. `stellar` / `base` are raw i128/uint256 decimal strings in the asset's
 * own units, or `null` when that chain does not apply (or the read failed). */
export interface AssetCustody {
  asset_id: number;
  symbol: string;
  decimals: number;
  kind: AssetKind;
  stellar: Amount | null;
  base: Amount | null;
}

export interface DeskCustody {
  desk_id: string;
  assets: AssetCustody[];
}

export interface ReadDeskCustodyOptions {
  desk: Pick<Desk, "id" | "contract_id" | "sponsor_pubkey" | "assets" | "base_deployment">;
  stellar: { rpcUrl: string; networkPassphrase: string };
  /** Optional Base RPC URL; falls back to viem's built-in Base Sepolia transport when omitted. */
  baseRpcUrl?: string;
  logger?: MosaicLogger;
}

/** Read a desk's total committed amounts per asset, on Stellar and Base. Individual per-asset reads
 * degrade to `null` (logged) rather than failing the whole call, so one bad token never blanks the
 * section. */
export async function readDeskCustody(opts: ReadDeskCustodyOptions): Promise<DeskCustody> {
  const logger = opts.logger ?? getMosaicLogger();
  const [stellar, base] = await Promise.all([readStellarTotals(opts, logger), readBaseTotals(opts, logger)]);
  const assets = opts.desk.assets.map((asset) => ({
    asset_id: asset.asset_id,
    symbol: asset.symbol,
    decimals: asset.decimals,
    kind: asset.kind,
    stellar: stellar.get(asset.asset_id) ?? null,
    base: base.get(asset.asset_id) ?? null,
  }));
  return { desk_id: opts.desk.id, assets };
}

async function readStellarTotals(opts: ReadDeskCustodyOptions, logger: MosaicLogger): Promise<Map<number, Amount>> {
  const totals = new Map<number, Amount>();
  const custodian = opts.desk.contract_id;
  const server = new rpc.Server(opts.stellar.rpcUrl);
  let account: Awaited<ReturnType<rpc.Server["getAccount"]>> | undefined;
  for (const asset of opts.desk.assets) {
    if (asset.kind === "BaseRepresented" || !asset.token) continue;
    try {
      account ??= await server.getAccount(opts.desk.sponsor_pubkey);
      const tokenId = resolveStellarTokenContractId(asset.token, opts.stellar.networkPassphrase);
      const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: opts.stellar.networkPassphrase })
        .addOperation(new Contract(tokenId).call("balance", new Address(custodian).toScVal()))
        .setTimeout(30)
        .build();
      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim) || !sim.result) {
        throw new Error(rpc.Api.isSimulationError(sim) ? String(sim.error) : "no simulation result");
      }
      totals.set(asset.asset_id, (scValToNative(sim.result.retval) as bigint).toString());
    } catch (error) {
      logger.warn("desk custody: stellar balance read failed", { asset_id: asset.asset_id, error });
    }
  }
  return totals;
}

async function readBaseTotals(opts: ReadDeskCustodyOptions, logger: MosaicLogger): Promise<Map<number, Amount>> {
  const totals = new Map<number, Amount>();
  const deployment = opts.desk.base_deployment;
  if (!deployment || deployment.status !== "active" || !deployment.bridge_address) return totals;
  const bridge = deployment.bridge_address as EvmAddress;
  const client = createPublicClient({ chain: baseSepolia, transport: http(opts.baseRpcUrl) });
  for (const mapping of deployment.assets) {
    try {
      const value =
        mapping.token.toLowerCase() === NATIVE_EVM_SENTINEL.toLowerCase()
          ? await client.getBalance({ address: bridge })
          : ((await client.readContract({
              address: mapping.token as EvmAddress,
              abi: ERC20_BALANCE_ABI,
              functionName: "balanceOf",
              args: [bridge],
            })) as bigint);
      totals.set(mapping.asset_id, value.toString());
    } catch (error) {
      logger.warn("desk custody: base balance read failed", { asset_id: mapping.asset_id, error });
    }
  }
  return totals;
}
