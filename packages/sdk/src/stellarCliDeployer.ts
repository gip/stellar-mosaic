// Node-only Stellar CLI deployer. This is the deployment adapter shared by the CLI and MCP:
// it shells to `stellar`, deploys the bundled settlement.wasm, and passes immutable assets/pairs
// into the constructor.

import { execFileSync, spawnSync } from "node:child_process";
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
// Stellar transaction hashes are 64 lowercase hex chars. The CLI logs the deploy tx hash (and an
// explorer link) to stderr; grab the last one so the caller can surface it in activity/explorer.
const TX_HASH = /\b[0-9a-f]{64}\b/g;

function lastTxHash(text: string): string | undefined {
  const matches = text.match(TX_HASH);
  return matches?.[matches.length - 1];
}

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
  private readonly stellarBin: string;

  constructor(opts: { network: NetworkConfig; source: string; stellarBin?: string }) {
    this.net = opts.network;
    this.source = opts.source;
    this.stellarBin = opts.stellarBin ?? "stellar";
  }

  private stellar(args: string[]): string {
    return execFileSync(this.stellarBin, args, { encoding: "utf8" });
  }

  /** Like {@link stellar} but also returns stderr (where the CLI logs the tx hash / explorer link). */
  private stellarWithLog(args: string[]): { stdout: string; stderr: string } {
    const result = spawnSync(this.stellarBin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(commandErrorText(result));
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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

  private resolveToken(token: string): string {
    if (CONTRACT_ID.test(token)) return token;
    const assetName = token === "native" || token.includes(":") ? token : null;
    if (!assetName) {
      throw new Error(`unsupported token "${token}"; pass "native", CODE:ISSUER, or a SAC contract id (C...)`);
    }
    const id = this.assetContractId(assetName);
    this.ensureAssetContract(assetName);
    return id;
  }

  async deploySettlement(params: {
    assets: AssetDef[];
    pairs: Omit<PairDef, "pair_id">[];
    admin: string;
  }): Promise<{ contractId: string; txHash?: string }> {
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
    const { stdout, stderr } = this.stellarWithLog([
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
    const contractId = stdout.split(/\s+/).find((t) => CONTRACT_ID.test(t));
    if (!contractId) throw new Error(`no contract id in deploy output: ${stdout}`);
    // Best-effort: the tx hash is logged to stderr, not stdout. Absence must not fail the deploy.
    return { contractId, txHash: lastTxHash(stderr) };
  }
}
