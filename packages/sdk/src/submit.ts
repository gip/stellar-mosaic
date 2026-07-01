// DirectSubmitter — the default {@link Submitter}: build, simulate, sign with the caller's own key,
// submit, and confirm one user-funded Soroban invocation. Ported from the frontend's
// `directTransaction.ts` `submitContractCall`, with two changes: signing goes through the injected
// {@link StellarSigner} (Freighter in the browser, a secret key in Node), and the IndexedDB
// submission journal is replaced by an optional `onStatus` hook (the browser adapter can re-add a
// durable journal; Node/CLI typically don't need one). This is the frontend's existing `direct`
// submission mode, made the default and environment-agnostic.

import { BASE_FEE, Contract, TransactionBuilder, rpc, type xdr } from "@stellar/stellar-sdk";
import type { ContractCall, NetworkConfig, StellarSigner, SubmitResult, Submitter } from "./ports.js";
import { ActivityHistory, type ActivityStore } from "./activity.js";
import { getMosaicLogger, serializeError, type MosaicLogger } from "./logging.js";
import { transactionErrorMessage } from "./transactionErrors.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type SubmitStatus = "prepared" | "submitted" | "succeeded" | "failed";

export interface DirectSubmitterOptions {
  network: NetworkConfig;
  signer: StellarSigner;
  activity?: ActivityStore;
  /** Optional lifecycle hook for journaling/telemetry (replaces the frontend's IDB journal). */
  onStatus?: (info: { hash: string; call: ContractCall; status: SubmitStatus; error?: string }) => void;
  /** Optional logger. Defaults to the SDK console logger. */
  logger?: MosaicLogger;
  /** Polling attempts at 1s each before giving up (default 120, matching the frontend). */
  confirmAttempts?: number;
  /** Test hook for no-network submitter tests. */
  server?: DirectSubmitterServer;
}

export type DirectSubmitterServer = Pick<
  rpc.Server,
  "getAccount" | "simulateTransaction" | "sendTransaction" | "getTransaction"
>;

export class DirectSubmitter implements Submitter {
  private readonly server: DirectSubmitterServer;
  private readonly networkPassphrase: string;
  private readonly signer: StellarSigner;
  private readonly onStatus?: DirectSubmitterOptions["onStatus"];
  private readonly attempts: number;
  private readonly logger: MosaicLogger;
  private readonly activity: ActivityHistory;

  constructor(opts: DirectSubmitterOptions) {
    this.server = opts.server ?? new rpc.Server(opts.network.rpcUrl);
    this.networkPassphrase = opts.network.networkPassphrase;
    this.signer = opts.signer;
    this.onStatus = opts.onStatus;
    this.attempts = opts.confirmAttempts ?? 120;
    this.logger = opts.logger ?? getMosaicLogger();
    this.activity = new ActivityHistory(opts.activity);
  }

  private async recordTx(call: ContractCall, status: SubmitStatus, hash?: string, error?: string): Promise<void> {
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
        metadata: { ...call.metadata, error },
      })
      .catch((cause) => this.logger.debug("activity transaction record failed", { error: cause }));
  }

  async submit(call: ContractCall): Promise<SubmitResult> {
    this.logger.info("transaction prepare started", { deskId: call.deskId, contractId: call.contractId, method: call.method });
    const source = await this.signer.address();
    const account = await this.server.getAccount(source);
    const raw = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(new Contract(call.contractId).call(call.method, ...(call.args as xdr.ScVal[])))
      .setTimeout(120)
      .build();

    const simulation = await this.server.simulateTransaction(raw);
    if (rpc.Api.isSimulationError(simulation)) {
      const message = transactionErrorMessage(simulation.error, call);
      this.logger.error("transaction simulation failed", {
        deskId: call.deskId,
        contractId: call.contractId,
        method: call.method,
        message,
        error: serializeError(simulation.error),
      });
      await this.recordTx(call, "failed", undefined, message);
      throw new Error(message);
    }
    const assembled = rpc.assembleTransaction(raw, simulation).build();
    const hash = assembled.hash().toString("hex");
    this.logger.info("transaction prepared", { deskId: call.deskId, method: call.method, hash });
    this.onStatus?.({ hash, call, status: "prepared" });
    await this.recordTx(call, "prepared", hash);

    const signedXdr = await this.signer.signTransaction(assembled.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const transaction = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);

    // Mark submitted before the network call: if the response is lost after acceptance, the
    // deterministic hash still lets a later reconciliation query the outcome.
    this.onStatus?.({ hash, call, status: "submitted" });
    await this.recordTx(call, "submitted", hash);
    this.logger.info("transaction submitting", { deskId: call.deskId, method: call.method, hash });
    const sent = await this.server.sendTransaction(transaction);
    if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
      const error = transactionErrorMessage(`RPC rejected transaction ${hash}: ${sent.status}`, call);
      this.onStatus?.({ hash, call, status: "failed", error });
      await this.recordTx(call, "failed", hash, error);
      this.logger.error("transaction rejected", { deskId: call.deskId, method: call.method, hash, error });
      throw new Error(error);
    }

    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const result = await this.server.getTransaction(hash);
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        this.onStatus?.({ hash, call, status: "succeeded" });
        await this.recordTx(call, "succeeded", hash);
        this.logger.info("transaction succeeded", { deskId: call.deskId, method: call.method, hash });
        return { txHash: hash, status: "SUCCESS" };
      }
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        const error = transactionErrorMessage(`Transaction ${hash} failed in ledger ${result.ledger}`, call);
        this.onStatus?.({ hash, call, status: "failed", error });
        await this.recordTx(call, "failed", hash, error);
        this.logger.error("transaction failed", { deskId: call.deskId, method: call.method, hash, error });
        throw new Error(error);
      }
      await sleep(1000);
    }
    const error = `Transaction ${hash} is still pending after ${this.attempts}s.`;
    this.logger.warn("transaction confirmation timed out", { deskId: call.deskId, method: call.method, hash, error });
    await this.recordTx(call, "failed", hash, error);
    throw new Error(error);
  }
}
