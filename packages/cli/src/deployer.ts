// A Deployer that shells out to the `stellar` CLI (the same recipe the Rust backend uses in
// backend/src/stellar.rs::deploy). It deploys the bundled settlement.wasm with the bundled VKs and
// the immutable asset/pair config in the constructor. `native` asset tokens are resolved to the XLM
// SAC via `stellar contract id asset`; BaseRepresented assets pass a null token.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AssetDef, Deployer, NetworkConfig, PairDef } from "@mosaic/sdk";

// Resolve the bundled-asset path lazily, so importing this module (e.g. for an offline command)
// does not require resolving @mosaic/sdk on disk.
let sdkRoot: string | undefined;
function asset(rel: string): string {
  sdkRoot ??= dirname(createRequire(import.meta.url).resolve("@mosaic/sdk/package.json"));
  return join(sdkRoot, "assets", rel);
}

const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

function commandErrorText(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) parts.push(error.message);
  const io = error as { stdout?: unknown; stderr?: unknown };
  for (const value of [io.stdout, io.stderr]) {
    if (value) parts.push(Buffer.isBuffer(value) ? value.toString("utf8") : String(value));
  }
  return parts.join("\n");
}

export class StellarCliDeployer implements Deployer {
  private readonly net: NetworkConfig;
  private readonly source: string;

  constructor(opts: { network: NetworkConfig; source: string }) {
    this.net = opts.network;
    this.source = opts.source;
  }

  private stellar(args: string[]): string {
    return execFileSync("stellar", args, { encoding: "utf8" });
  }

  private netFlags(): string[] {
    return ["--rpc-url", this.net.rpcUrl, "--network-passphrase", this.net.networkPassphrase];
  }

  private assetContractId(assetName: string): string {
    const out = this.stellar([
      "contract",
      "id",
      "asset",
      "--asset",
      assetName,
      ...this.netFlags(),
    ]);
    const id = out.split(/\s+/).find((t) => CONTRACT_ID.test(t));
    if (!id) throw new Error(`could not resolve SAC for ${assetName}: ${out}`);
    return id;
  }

  private ensureAssetContract(assetName: string): void {
    if (!assetName.includes(":")) return;
    try {
      this.stellar([
        "contract",
        "asset",
        "deploy",
        "--asset",
        assetName,
        "--source-account",
        this.source,
        ...this.netFlags(),
      ]);
    } catch (error) {
      const message = commandErrorText(error);
      if (!message.includes("already") && !message.includes("ExistingValue")) throw error;
    }
  }

  /** Resolve a token reference to a SAC contract id. `native` -> XLM SAC; `C...` used as-is. */
  private resolveToken(token: string): string {
    if (CONTRACT_ID.test(token)) return token;
    const assetName = token === "native" || token.includes(":") ? token : null;
    if (assetName) {
      const id = this.assetContractId(assetName);
      this.ensureAssetContract(assetName);
      return id;
    }
    throw new Error(`unsupported token "${token}"; pass "native", CODE:ISSUER, or a SAC contract id (C...)`);
  }

  async deploySettlement(params: {
    assets: AssetDef[];
    pairs: Omit<PairDef, "pair_id">[];
    admin: string;
  }): Promise<{ contractId: string }> {
    const assetsJson = JSON.stringify(
      params.assets.map((a) => ({
        asset_id: a.asset_id,
        token: a.kind === "BaseRepresented" ? null : this.resolveToken(a.token ?? "native"),
        kind: a.kind,
      })),
    );
    const pairsJson = JSON.stringify(
      params.pairs.map((p) => ({ base_asset: p.base_asset, quote_asset: p.quote_asset })),
    );

    const out = this.stellar([
      "contract",
      "deploy",
      "--wasm",
      asset("settlement.wasm"),
      "--source-account",
      this.source,
      ...this.netFlags(),
      "--",
      "--lift_vk-file-path",
      asset("vks/lift_vk"),
      "--unshield_vk-file-path",
      asset("vks/unshield_vk"),
      "--cancel_vk-file-path",
      asset("vks/cancel_vk"),
      "--join_vk-file-path",
      asset("vks/join_vk"),
      "--admin",
      params.admin,
      "--assets",
      assetsJson,
      "--pairs",
      pairsJson,
    ]);
    const contractId = out.split(/\s+/).find((t) => CONTRACT_ID.test(t));
    if (!contractId) throw new Error(`no contract id in deploy output: ${out}`);
    return { contractId };
  }
}
