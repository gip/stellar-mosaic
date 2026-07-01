import { BASE_FEE, Contract, Networks, TransactionBuilder, nativeToScVal, rpc, scValToNative } from "@stellar/stellar-sdk";
import type { BookOrder, BookSide, Desk, Field, Side } from "@mosaic/sdk";

export interface StellarBookReaderOptions {
  rpcUrl?: string;
  networkPassphrase?: string;
}

function bytesHex(value: unknown): Field {
  const bytes =
    value instanceof Uint8Array ? value : ArrayBuffer.isView(value) ? new Uint8Array((value as ArrayBufferView).buffer) : null;
  if (!bytes) throw new Error("expected bytes from contract view");
  return `0x${Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value instanceof Map) return Object.fromEntries(value.entries()) as Record<string, unknown>;
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error(`invalid ${label}`);
}

function bigint(value: unknown, label: string): bigint {
  if (typeof value !== "bigint") throw new Error(`invalid ${label}`);
  return value;
}

function side(value: number): Side {
  if (value !== 0 && value !== 1) throw new Error("side must be 0 (BUY) or 1 (SELL)");
  return value;
}

export class StellarBookReader {
  private readonly rpcUrl: string;
  private readonly networkPassphrase: string;

  constructor(opts: StellarBookReaderOptions = {}) {
    this.rpcUrl = opts.rpcUrl ?? process.env.MOSAIC_RPC ?? "https://soroban-testnet.stellar.org";
    this.networkPassphrase = opts.networkPassphrase ?? process.env.MOSAIC_NETWORK_PASSPHRASE ?? Networks.TESTNET;
  }

  async getBook(desk: Desk, pair: number, rawSide: number): Promise<BookSide> {
    if (!Number.isSafeInteger(pair) || pair < 0) throw new Error("pair must be a non-negative integer");
    const bookSide = side(rawSide);
    const server = new rpc.Server(this.rpcUrl);
    const account = await server.getAccount(desk.sponsor_pubkey);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
      .addOperation(
        new Contract(desk.contract_id).call(
          "book",
          nativeToScVal(pair, { type: "u32" }),
          nativeToScVal(bookSide, { type: "u32" }),
        ),
      )
      .setTimeout(30)
      .build();
    const simulation = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulation) || !simulation.result) {
      const suffix = rpc.Api.isSimulationError(simulation) ? `: ${String(simulation.error)}` : "";
      throw new Error(`book simulation failed${suffix}`);
    }
    const native = scValToNative(simulation.result.retval);
    const entries = Array.isArray(native) ? native : [];
    const orders: BookOrder[] = entries.map((entry, index) => {
      const r = record(entry, "book entry");
      return {
        order_id: bytesHex(r.order_id),
        amount_in: bigint(r.amount_in, "amount_in").toString(),
        min_out: bigint(r.min_out, "min_out").toString(),
        remaining_in: bigint(r.remaining_in, "remaining_in").toString(),
        output_owner_tag: bytesHex(r.output_owner_tag),
        cancel_owner_tag: bytesHex(r.cancel_owner_tag),
        order_leaf: bytesHex(r.order_leaf),
        expiry: bigint(r.expiry, "expiry").toString(),
        partial_allowed: Boolean(r.partial_allowed),
        priority_sequence: (index + 1).toString(),
      };
    });
    return { pair, side: bookSide, orders };
  }
}
