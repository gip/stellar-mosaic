// A {@link StellarSigner} backed by a raw Stellar secret seed (S...). This is the headless
// counterpart to the browser's FreighterSigner: it signs and pays for its own transactions, which
// is exactly the "fully local" mode (no sponsor/relay). Built only on `@stellar/stellar-sdk`, so it
// runs in Node (CLI/MCP/tests) and anywhere stellar-sdk loads.

import { Keypair, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import type { StellarSigner } from "./ports.js";

export class SecretKeySigner implements StellarSigner {
  private readonly kp: Keypair;

  constructor(secret: string) {
    this.kp = Keypair.fromSecret(secret);
  }

  async address(): Promise<string> {
    return this.kp.publicKey();
  }

  async signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string> {
    const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase) as Transaction;
    tx.sign(this.kp);
    return tx.toXDR();
  }

  async signAuthEntry(): Promise<string> {
    // Sponsored/relayed flows aren't part of local mode; a SecretKeySigner pays its own fees.
    throw new Error("SecretKeySigner does not support signAuthEntry (use direct submission)");
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return Uint8Array.from(this.kp.sign(Buffer.from(message)));
  }
}
