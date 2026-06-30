// Node-only Stellar CLI deployer. This is the deployment adapter shared by the CLI and MCP:
// it shells to `stellar`, deploys the bundled settlement.wasm, and passes immutable assets/pairs
// into the constructor.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Deployer, NetworkConfig } from "./ports.js";
import type { AssetDef, PairDef } from "./types.js";

let sdkRoot: string | undefined;
function asset(rel: string): string {
  sdkRoot ??= dirname(createRequire(import.meta.url).resolve("@mosaic/sdk/package.json"));
  return join(sdkRoot, "assets", rel);
}

const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

export class StellarCliDeployer implements Deployer {
  private readonly net: NetworkConfig;
  private readonly source: string;
  private readonly stellarBin: string;

  constructor(opts: { network: NetworkConfig; source: string; stellarBin?: string }) {
    this.net = opts.network;
    this.source = opts.source;
    this.stellarBin = opts.stellarBin ?? "stellar";
  }

  private stellar(args: string[]): string {
    return execFileSync(this.stellarBin, args, { encoding: "utf8" });
  }

  private netFlags(): string[] {
    return ["--rpc-url", this.net.rpcUrl, "--network-passphrase", this.net.networkPassphrase];
  }

  private resolveToken(token: string): string {
    if (CONTRACT_ID.test(token)) return token;
    const assetName = token === "native" || token.includes(":") ? token : null;
    if (!assetName) {
      throw new Error(`unsupported token "${token}"; pass "native", CODE:ISSUER, or a SAC contract id (C...)`);
    }
    if (assetName.includes(":")) {
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
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("already") && !message.includes("ExistingValue")) throw error;
      }
    }
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
