// Note-tree event reader. The settlement contract only stores filled subtrees on-chain, so the
// membership paths must be rebuilt off-chain from the insertion-ordered note-tree events. Today the
// Rust backend does this; in local mode the SDK reads the same events directly via Soroban RPC
// `getEvents` and feeds them to {@link LocalPathProvider}.
//
// Wire format (contracts/settlement/src/lib.rs, `data_format="vec"`): one short-Symbol topic + an
// ScVal::Vec of fields in declaration order. Only the tree-affecting topics are consumed here;
// everything else (unshield/joined/filled/book events) is ignored for tree reconstruction.

import { rpc, scValToNative } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "./ports.js";
import type { Amount, Field, TreeEvent } from "./types.js";

function hex(value: unknown): Field {
  const bytes =
    value instanceof Uint8Array ? value : ArrayBuffer.isView(value) ? new Uint8Array((value as ArrayBufferView).buffer) : null;
  if (!bytes) throw new Error("expected bytes (BytesN<32>) in note-tree event");
  return `0x${Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function num(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : (value as number);
  if (!Number.isSafeInteger(n)) throw new Error("invalid u32 in note-tree event");
  return n;
}

function amt(value: unknown): Amount {
  if (typeof value !== "bigint") throw new Error("invalid i128 in note-tree event");
  return value.toString();
}

/** Parse one contract event into a {@link TreeEvent}, or null if it doesn't affect the tree. */
function parseTreeEvent(event: rpc.Api.EventResponse): TreeEvent | null {
  const topic = scValToNative(event.topic[0]) as string;
  if (topic !== "shielded" && topic !== "noteins" && topic !== "settled") return null;
  const f = scValToNative(event.value) as unknown[];
  if (topic === "shielded" || topic === "noteins") {
    return { kind: topic, asset: num(f[0]), amount: amt(f[1]), owner_tag: hex(f[2]) };
  }
  return {
    kind: "settled",
    a_asset_out: num(f[0]),
    b_amount_in: amt(f[1]),
    a_output_owner_tag: hex(f[2]),
    b_asset_out: num(f[3]),
    a_amount_in: amt(f[4]),
    b_output_owner_tag: hex(f[5]),
  };
}

interface ContractState {
  cursor?: string;
  acc: TreeEvent[];
}

/** Stateful, incremental reader of a desk's note-tree events. Keeps a per-contract cursor and the
 * accumulated insertion-ordered list, so repeated `events()` calls only fetch new pages. Use as the
 * {@link LocalPathProvider} event source. */
export class ChainEventSource {
  private readonly server: rpc.Server;
  private readonly startLedger?: number;
  private readonly state = new Map<string, ContractState>();

  constructor(opts: { network: NetworkConfig; startLedger?: number }) {
    this.server = new rpc.Server(opts.network.rpcUrl);
    this.startLedger = opts.startLedger;
  }

  /** Fetch any new events for a contract and return the full insertion-ordered tree-event list. */
  async events(contractId: string, startLedger?: number): Promise<TreeEvent[]> {
    const st = this.state.get(contractId) ?? { acc: [] };
    this.state.set(contractId, st);
    const filters = [{ type: "contract" as const, contractIds: [contractId] }];
    for (;;) {
      let page: rpc.Api.GetEventsResponse;
      if (st.cursor) {
        page = await this.server.getEvents({ filters, cursor: st.cursor, limit: 1000 });
      } else {
        const from = startLedger ?? this.startLedger;
        if (from === undefined) {
          throw new Error("ChainEventSource needs a startLedger for the first read of a contract");
        }
        page = await this.server.getEvents({ filters, startLedger: from, limit: 1000 });
      }
      for (const ev of page.events) {
        const t = parseTreeEvent(ev);
        if (t) st.acc.push(t);
      }
      st.cursor = page.cursor;
      if (page.events.length < 1000) break;
    }
    return st.acc;
  }
}
