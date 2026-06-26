// DirectSubmitter — the default {@link Submitter}: build, simulate, sign with the caller's own key,
// submit, and confirm one user-funded Soroban invocation. Ported from the frontend's
// `directTransaction.ts` `submitContractCall`, with two changes: signing goes through the injected
// {@link StellarSigner} (Freighter in the browser, a secret key in Node), and the IndexedDB
// submission journal is replaced by an optional `onStatus` hook (the browser adapter can re-add a
// durable journal; Node/CLI typically don't need one). This is the frontend's existing `direct`
// submission mode, made the default and environment-agnostic.

import { BASE_FEE, Contract, TransactionBuilder, rpc, type xdr } from "@stellar/stellar-sdk";
import type { ContractCall, NetworkConfig, StellarSigner, SubmitResult, Submitter } from "./ports.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type SubmitStatus = "prepared" | "submitted" | "succeeded" | "failed";

export interface DirectSubmitterOptions {
  network: NetworkConfig;
  signer: StellarSigner;
  /** Optional lifecycle hook for journaling/telemetry (replaces the frontend's IDB journal). */
  onStatus?: (info: { hash: string; call: ContractCall; status: SubmitStatus; error?: string }) => void;
  /** Polling attempts at 1s each before giving up (default 120, matching the frontend). */
  confirmAttempts?: number;
}

export class DirectSubmitter implements Submitter {
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly signer: StellarSigner;
  private readonly onStatus?: DirectSubmitterOptions["onStatus"];
  private readonly attempts: number;

  constructor(opts: DirectSubmitterOptions) {
    this.server = new rpc.Server(opts.network.rpcUrl);
    this.networkPassphrase = opts.network.networkPassphrase;
    this.signer = opts.signer;
    this.onStatus = opts.onStatus;
    this.attempts = opts.confirmAttempts ?? 120;
  }

  async submit(call: ContractCall): Promise<SubmitResult> {
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
      throw new Error(`Simulation failed: ${simulation.error}`);
    }
    const assembled = rpc.assembleTransaction(raw, simulation).build();
    const hash = assembled.hash().toString("hex");
    this.onStatus?.({ hash, call, status: "prepared" });

    const signedXdr = await this.signer.signTransaction(assembled.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const transaction = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);

    // Mark submitted before the network call: if the response is lost after acceptance, the
    // deterministic hash still lets a later reconciliation query the outcome.
    this.onStatus?.({ hash, call, status: "submitted" });
    const sent = await this.server.sendTransaction(transaction);
    if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
      const error = `RPC rejected transaction ${hash}: ${sent.status}`;
      this.onStatus?.({ hash, call, status: "failed", error });
      throw new Error(error);
    }

    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const result = await this.server.getTransaction(hash);
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        this.onStatus?.({ hash, call, status: "succeeded" });
        return { txHash: hash, status: "SUCCESS" };
      }
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        const error = `Transaction ${hash} failed in ledger ${result.ledger}`;
        this.onStatus?.({ hash, call, status: "failed", error });
        throw new Error(error);
      }
      await sleep(1000);
    }
    throw new Error(`Transaction ${hash} is still pending after ${this.attempts}s.`);
  }
}
