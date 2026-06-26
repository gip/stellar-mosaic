// Portable Stellar RPC deployer. Unlike StellarCliDeployer this runs in browsers too: transactions
// are signed by the injected StellarSigner, so frontend deployment is self-funded by the connected
// wallet rather than sponsored by MCP.

import { Buffer } from "buffer";
import {
  Address,
  Asset,
  BASE_FEE,
  Operation as StellarOperation,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { AssetDef } from "./types.js";
import type { Deployer, NetworkConfig, StellarSigner } from "./ports.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

export interface StellarRpcDeployerOptions {
  network: NetworkConfig;
  signer: StellarSigner;
  loadSettlementWasm: () => Promise<Uint8Array>;
  loadVk: (name: "lift" | "unshield" | "cancel" | "join") => Promise<Uint8Array>;
  confirmAttempts?: number;
}

export class StellarRpcDeployer implements Deployer {
  private readonly server: rpc.Server;
  private readonly network: NetworkConfig;
  private readonly signer: StellarSigner;
  private readonly loadSettlementWasm: StellarRpcDeployerOptions["loadSettlementWasm"];
  private readonly loadVk: StellarRpcDeployerOptions["loadVk"];
  private readonly attempts: number;

  constructor(opts: StellarRpcDeployerOptions) {
    this.server = new rpc.Server(opts.network.rpcUrl);
    this.network = opts.network;
    this.signer = opts.signer;
    this.loadSettlementWasm = opts.loadSettlementWasm;
    this.loadVk = opts.loadVk;
    this.attempts = opts.confirmAttempts ?? 120;
  }

  async deploySettlement(params: {
    assets: AssetDef[];
    pairs: { base_asset: number; quote_asset: number }[];
    admin: string;
  }): Promise<{ contractId: string }> {
    const wasm = await this.loadSettlementWasm();
    const wasmHash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", Buffer.from(wasm)));
    await this.submitOperation(StellarOperation.uploadContractWasm({ wasm }));
    const constructorArgs = [
      this.bytes(await this.loadVk("lift")),
      this.bytes(await this.loadVk("unshield")),
      this.bytes(await this.loadVk("cancel")),
      this.bytes(await this.loadVk("join")),
      new Address(params.admin).toScVal(),
      xdr.ScVal.scvVec(params.assets.map((asset) => this.assetInit(asset))),
      xdr.ScVal.scvVec(params.pairs.map((pair) => this.pairDef(pair))),
    ];
    const result = await this.submitOperation(
      StellarOperation.createCustomContract({
        address: new Address(params.admin),
        wasmHash,
        constructorArgs,
      }),
    );
    if (!result.returnValue) throw new Error("deploy transaction returned no contract id");
    return { contractId: Address.fromScVal(result.returnValue).toString() };
  }

  private assetInit(asset: AssetDef): xdr.ScVal {
    const token = asset.kind === "BaseRepresented" ? null : this.resolveToken(asset.token ?? "native");
    return this.map([
      ["asset_id", xdr.ScVal.scvU32(asset.asset_id)],
      ["kind", this.enumUnit(asset.kind)],
      ["token", token ? new Address(token).toScVal() : xdr.ScVal.scvVoid()],
    ]);
  }

  private pairDef(pair: { base_asset: number; quote_asset: number }): xdr.ScVal {
    return this.map([
      ["base_asset", xdr.ScVal.scvU32(pair.base_asset)],
      ["quote_asset", xdr.ScVal.scvU32(pair.quote_asset)],
    ]);
  }

  private resolveToken(token: string): string {
    if (CONTRACT_ID.test(token)) return token;
    if (token === "native") return Asset.native().contractId(this.network.networkPassphrase);
    const [code, issuer] = token.split(":");
    if (code && issuer) return new Asset(code, issuer).contractId(this.network.networkPassphrase);
    throw new Error(`unsupported token "${token}"; pass "native", CODE:ISSUER, or a SAC contract id (C...)`);
  }

  private map(entries: [string, xdr.ScVal][]): xdr.ScVal {
    return xdr.ScVal.scvMap(
      entries
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
    );
  }

  private enumUnit(name: string): xdr.ScVal {
    return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]);
  }

  private bytes(value: Uint8Array): xdr.ScVal {
    return xdr.ScVal.scvBytes(Buffer.from(value));
  }

  private async submitOperation(operation: xdr.Operation): Promise<{ txHash: string; returnValue?: xdr.ScVal }> {
    const source = await this.signer.address();
    const account = await this.server.getAccount(source);
    const raw = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.network.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(120)
      .build();
    const simulation = await this.server.simulateTransaction(raw);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`Simulation failed: ${simulation.error}`);
    }
    const assembled = rpc.assembleTransaction(raw, simulation).build();
    const hash = assembled.hash().toString("hex");
    const signedXdr = await this.signer.signTransaction(assembled.toXDR(), {
      networkPassphrase: this.network.networkPassphrase,
    });
    const transaction = TransactionBuilder.fromXDR(signedXdr, this.network.networkPassphrase);
    const sent = await this.server.sendTransaction(transaction);
    if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
      throw new Error(`RPC rejected transaction ${hash}: ${sent.status}`);
    }
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const result = await this.server.getTransaction(hash);
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return { txHash: hash, returnValue: result.returnValue };
      }
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction ${hash} failed in ledger ${result.ledger}`);
      }
      await sleep(1000);
    }
    throw new Error(`Transaction ${hash} is still pending after ${this.attempts}s.`);
  }
}
