import {
  Address,
  BASE_FEE,
  Contract,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import type {
  ClientActionLease,
  ContractCall,
  DeskProvider,
  McpClient,
  NetworkConfig,
  StellarSigner,
  SubmitResult,
  Submitter,
} from "./ports.js";
import { ActivityHistory, type ActivityStore } from "./activity.js";

function b64FromScBytes(value: unknown): string {
  const native = scValToNative(value as xdr.ScVal);
  const bytes =
    native instanceof Uint8Array
      ? native
      : ArrayBuffer.isView(native)
        ? new Uint8Array(native.buffer, native.byteOffset, native.byteLength)
        : null;
  if (!bytes) throw new Error("Expected a bytes ScVal.");
  return Buffer.from(bytes).toString("base64");
}

function numberFromScVal(value: unknown): number {
  const native = scValToNative(value as xdr.ScVal);
  const n = typeof native === "bigint" ? Number(native) : Number(native);
  if (!Number.isSafeInteger(n)) throw new Error("Expected a numeric ScVal.");
  return n;
}

function addressFromScVal(value: unknown): string {
  const native = scValToNative(value as xdr.ScVal);
  if (typeof native !== "string") throw new Error("Expected an address ScVal.");
  return native;
}

export interface SponsoredSubmitterOptions {
  network: NetworkConfig;
  signer: StellarSigner;
  desks: DeskProvider;
  mcp: McpClient;
  activity?: ActivityStore;
  /** Current leased client action, supplied by the operation runner. */
  lease?: () => ClientActionLease | undefined;
}

/** Submitter that preserves the SDK's local proving/coin-selection flow but sends the final
 * transaction through the authenticated MCP sponsor. */
export class SponsoredSubmitter implements Submitter {
  private readonly network: NetworkConfig;
  private readonly signer: StellarSigner;
  private readonly desks: DeskProvider;
  private readonly mcp: McpClient;
  private readonly lease?: () => ClientActionLease | undefined;
  private readonly activity: ActivityHistory;

  constructor(opts: SponsoredSubmitterOptions) {
    this.network = opts.network;
    this.signer = opts.signer;
    this.desks = opts.desks;
    this.mcp = opts.mcp;
    this.lease = opts.lease;
    this.activity = new ActivityHistory(opts.activity);
  }

  async submit(call: ContractCall): Promise<SubmitResult> {
    if (!call.deskId) throw new Error("Sponsored submission requires call.deskId.");
    const lease = this.lease?.();
    await this.recordTx(call, "submitted");
    let result: SubmitResult;
    try {
      switch (call.method) {
        case "shield":
          result = await this.mcp.relayShield(call.deskId, await this.buildSponsoredShield(call), lease);
          break;
        case "submit_order":
          result = await this.mcp.relayOrder(call.deskId, b64FromScBytes(call.args[0]), b64FromScBytes(call.args[1]), lease);
          break;
        case "join":
          result = await this.mcp.relayJoin(call.deskId, b64FromScBytes(call.args[0]), b64FromScBytes(call.args[1]), lease);
          break;
        case "unshield":
          result = await this.mcp.relayUnshield(
            call.deskId,
            addressFromScVal(call.args[0]),
            b64FromScBytes(call.args[1]),
            b64FromScBytes(call.args[2]),
            lease,
          );
          break;
        case "cancel_order":
          result = await this.mcp.relayCancel(
            call.deskId,
            numberFromScVal(call.args[0]),
            numberFromScVal(call.args[1]),
            b64FromScBytes(call.args[2]),
            b64FromScBytes(call.args[3]),
            lease,
          );
          break;
        default:
          throw new Error(`Unsupported sponsored contract method: ${call.method}`);
      }
    } catch (error) {
      await this.recordTx(call, "failed", undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
    await this.recordTx(call, "succeeded", result.txHash, undefined, result.status);
    return result;
  }

  private async recordTx(
    call: ContractCall,
    status: "submitted" | "succeeded" | "failed",
    hash?: string,
    error?: string,
    resultStatus?: string,
  ): Promise<void> {
    await this.activity
      .record({
        kind: "transaction",
        idempotency_key: hash ? `tx:${hash}:${status}` : undefined,
        status,
        desk_id: call.deskId,
        contract_id: call.contractId,
        method: call.method,
        tx_hash: hash,
        message: error,
        metadata: { sponsored: true, result_status: resultStatus, error },
      })
      .catch(() => undefined);
  }

  private async buildSponsoredShield(call: ContractCall): Promise<string> {
    if (!call.deskId) throw new Error("Sponsored shield requires call.deskId.");
    const desk = await this.desks.get(call.deskId);
    if (!desk.sponsor) throw new Error("Desk has no sponsor public key.");
    const server = new rpc.Server(this.network.rpcUrl);
    const sponsorAccount = await server.getAccount(desk.sponsor);
    const probe = new TransactionBuilder(sponsorAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.network.networkPassphrase,
    })
      .addOperation(new Contract(call.contractId).call("shield", ...(call.args as xdr.ScVal[])))
      .setTimeout(120)
      .build();
    const sim = await server.simulateTransaction(probe);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`Simulation failed: ${sim.error}`);

    const validUntil = sim.latestLedger + 60;
    const auth = sim.result?.auth ?? [];
    const signedAuth = await Promise.all(
      auth.map((entry) =>
        authorizeEntry(
          entry,
          async (preimage) =>
            Buffer.from(
              await this.signer.signAuthEntry(preimage.toXDR("base64"), {
                networkPassphrase: this.network.networkPassphrase,
              }),
              "base64",
            ),
          validUntil,
          this.network.networkPassphrase,
        ),
      ),
    );

    const account = await server.getAccount(desk.sponsor);
    const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(call.contractId).toScAddress(),
        functionName: "shield",
        args: call.args as xdr.ScVal[],
      }),
    );
    const fee = String(Number(BASE_FEE) + Number(sim.minResourceFee));
    return new TransactionBuilder(account, { fee, networkPassphrase: this.network.networkPassphrase })
      .addOperation(Operation.invokeHostFunction({ func, auth: signedAuth }))
      .setSorobanData(sim.transactionData.build())
      .setTimeout(120)
      .build()
      .toXDR();
  }
}
