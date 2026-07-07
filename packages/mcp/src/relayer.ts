import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { errorMessage, type Operation, type SubmitResult } from "@mosaic/sdk";
import type { RelayHandlers } from "./server.js";
import type { MosaicStore } from "./store.js";
import { envNumber } from "./env.js";
import { MosaicMcpError } from "./errors.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CLI_TIMEOUT_MS = 120_000;

export interface StellarRelayerOptions {
  store: MosaicStore;
  stellarBin?: string;
  network?: string;
  validatorUrl?: string;
  validatorToken?: string;
}

function parseResult(out: string): SubmitResult {
  try {
    const json = JSON.parse(out) as { status?: string; tx_hash?: string };
    return { status: json.status ?? "SUCCESS", txHash: json.tx_hash ?? "" };
  } catch {
    const parts = out.trim().split(/\s+/);
    return { status: parts[0] ?? "SUCCESS", txHash: parts.at(-1) ?? "" };
  }
}

function b64File(dir: string, name: string, value: string): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.from(value.trim(), "base64"));
  return path;
}


export class StellarCliRelayer implements RelayHandlers {
  private readonly store: MosaicStore;
  private readonly stellarBin: string;
  private readonly network: string;
  private readonly validatorUrl?: string;
  private readonly validatorToken?: string;

  constructor(opts: StellarRelayerOptions) {
    this.store = opts.store;
    this.stellarBin = opts.stellarBin ?? process.env.MOSAIC_STELLAR_BIN ?? "stellar";
    this.network = opts.network ?? process.env.MOSAIC_NETWORK ?? "testnet";
    this.validatorUrl = opts.validatorUrl ?? process.env.MOSAIC_RELAY_VALIDATOR_URL;
    this.validatorToken = opts.validatorToken ?? process.env.MOSAIC_PROVER_TOKEN;
  }

  async relayShield(args: { desk_id: string; tx_xdr: string; operation?: Operation | null }): Promise<SubmitResult> {
    await this.validateRelay("relay_shield", args.desk_id, args.operation, {
      tx_xdr: args.tx_xdr,
      address: args.operation?.address,
    });
    const secret = await this.requireSponsor(args.desk_id);
    const signed = await this.run(["tx", "sign", args.tx_xdr, "--sign-with-key", secret, "--network", this.network]);
    return parseResult(await this.run(["tx", "send", signed.trim(), "--network", this.network]));
  }

  async relayOrder(args: { desk_id: string; proof_b64: string; public_inputs_b64: string; operation?: Operation | null }): Promise<SubmitResult> {
    await this.validateRelay("relay_order", args.desk_id, args.operation, { public_inputs_b64: args.public_inputs_b64 });
    return this.relayProof(args.desk_id, args.proof_b64, args.public_inputs_b64, (proof, pi) => [
      "submit_order",
      "--proof-file-path",
      proof,
      "--public_inputs-file-path",
      pi,
    ]);
  }

  async relayJoin(args: { desk_id: string; proof_b64: string; public_inputs_b64: string; operation?: Operation | null }): Promise<SubmitResult> {
    await this.validateRelay("relay_join", args.desk_id, args.operation, { public_inputs_b64: args.public_inputs_b64 });
    return this.relayProof(args.desk_id, args.proof_b64, args.public_inputs_b64, (proof, pi) => [
      "join",
      "--proof-file-path",
      proof,
      "--public_inputs-file-path",
      pi,
    ]);
  }

  async relayUnshield(args: {
    desk_id: string;
    to: string;
    proof_b64: string;
    public_inputs_b64: string;
    operation?: Operation | null;
  }): Promise<SubmitResult> {
    await this.validateRelay("relay_unshield", args.desk_id, args.operation, { public_inputs_b64: args.public_inputs_b64 });
    return this.relayProof(args.desk_id, args.proof_b64, args.public_inputs_b64, (proof, pi) => [
      "unshield",
      "--to",
      args.to,
      "--proof_bytes-file-path",
      proof,
      "--public_inputs-file-path",
      pi,
    ]);
  }

  async relayCancel(args: {
    desk_id: string;
    pair_id: number;
    side: number;
    proof_b64: string;
    public_inputs_b64: string;
    operation?: Operation | null;
  }): Promise<SubmitResult> {
    await this.validateRelay("relay_cancel", args.desk_id, args.operation, { public_inputs_b64: args.public_inputs_b64 });
    return this.relayProof(args.desk_id, args.proof_b64, args.public_inputs_b64, (proof, pi) => [
      "cancel_order",
      "--pair_id",
      String(args.pair_id),
      "--side",
      String(args.side),
      "--proof-file-path",
      proof,
      "--public_inputs-file-path",
      pi,
    ]);
  }

  private async relayProof(
    deskId: string,
    proofB64: string,
    publicInputsB64: string,
    buildArgs: (proof: string, publicInputs: string) => string[],
  ): Promise<SubmitResult> {
    const [desk, secret] = await Promise.all([this.store.getDesk(deskId), this.requireSponsor(deskId)]);
    const dir = mkdtempSync(join(tmpdir(), "mosaic-mcp-relay-"));
    try {
      const proof = b64File(dir, "proof.bin", proofB64);
      const publicInputs = b64File(dir, "public_inputs.bin", publicInputsB64);
      return parseResult(
        await this.run([
          "contract",
          "invoke",
          "--id",
          desk.contract_id,
          "--source-account",
          secret,
          "--network",
          this.network,
          "--send",
          "yes",
          "--",
          ...buildArgs(proof, publicInputs),
        ]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async requireSponsor(deskId: string): Promise<string> {
    const secret = await this.store.sponsorSecret(deskId);
    if (!secret) throw new Error("desk has no sponsor key");
    return secret;
  }

  private async validateRelay(
    action: string,
    deskId: string,
    operation: Operation | null | undefined,
    extra: { public_inputs_b64?: string; tx_xdr?: string; address?: string },
  ): Promise<void> {
    if (!this.validatorUrl) return;
    if (!operation) throw new Error("Rust relay validation requires a leased operation");
    if (!this.validatorToken) throw new Error("MOSAIC_PROVER_TOKEN is required for Rust relay validation");
    const desk = await this.store.getDesk(deskId);
    const response = await fetch(this.validatorUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.validatorToken}`,
      },
      body: JSON.stringify({
        action,
        desk,
        request: operation.request,
        address: extra.address ?? operation.address,
        public_inputs_b64: extra.public_inputs_b64,
        tx_xdr: extra.tx_xdr,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Rust relay validation failed (${response.status}): ${text}`);
    }
  }

  private async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.stellarBin, args, {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: envNumber("MOSAIC_MCP_CLI_TIMEOUT_MS", DEFAULT_CLI_TIMEOUT_MS),
      });
      return stdout.trim();
    } catch (cause) {
      const message = errorMessage(cause);
      const timedOut = !!(cause && typeof cause === "object" && "killed" in cause && (cause as { killed?: boolean }).killed);
      if (timedOut) throw new MosaicMcpError("CLI_TIMEOUT", `stellar CLI timed out: ${message}`, { retryable: true, cause });
      // A transient infrastructure failure (RPC 5xx, connection reset, DNS) must stay retryable —
      // reporting it as a permanent RELAY_REJECTED would abandon an already-signed transaction that
      // an immediate retry would land. Only a genuine rejection (the tx reached the network and was
      // refused) is terminal.
      if (isTransientCliFailure(message)) throw new MosaicMcpError("UNAVAILABLE", `stellar CLI transient failure: ${message}`, { retryable: true, cause });
      throw new MosaicMcpError("RELAY_REJECTED", `stellar CLI failed: ${message}`, { retryable: false, cause });
    }
  }
}

/** Whether a `stellar` CLI failure looks like a transient network/RPC condition (safe to retry) as
 * opposed to a definite contract/transaction rejection. Heuristic on the CLI's error text; errs
 * toward terminal (a missing binary or bad args is not matched, since retrying cannot help). */
function isTransientCliFailure(message: string): boolean {
  return /timed out|timeout|connection|econnrefused|econnreset|etimedout|ehostunreach|enetunreach|enotfound|socket hang up|network|temporarily|try again|rate limit|too many requests|\b429\b|\b50[234]\b|bad gateway|service unavailable|gateway timeout|sending request|upstream/i.test(
    message,
  );
}
