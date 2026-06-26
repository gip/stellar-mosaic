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
import type { Amount, Field, Fill, TreeEvent } from "./types.js";
import { ActivityHistory, type ActivityStore } from "./activity.js";
import { getMosaicLogger, type MosaicLogger } from "./logging.js";

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

function eventId(event: rpc.Api.EventResponse): string {
  const raw = event as unknown as { id?: string; ledger?: number | string; txHash?: string };
  return raw.id ?? `${raw.ledger ?? 0}:${raw.txHash ?? ""}`;
}

function eventLedger(event: rpc.Api.EventResponse): number {
  const raw = event as unknown as { ledger?: number | string };
  const n = typeof raw.ledger === "string" ? Number(raw.ledger) : (raw.ledger ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function eventTxHash(event: rpc.Api.EventResponse): string {
  const raw = event as unknown as { txHash?: string; tx_hash?: string };
  return raw.txHash ?? raw.tx_hash ?? "";
}

function eventTopic(event: rpc.Api.EventResponse): string {
  try {
    return scValToNative(event.topic[0]) as string;
  } catch {
    return "";
  }
}

/** Parse one contract event into a {@link TreeEvent}, or null if it doesn't affect the tree. */
export function parseTreeEvent(event: rpc.Api.EventResponse): TreeEvent | null {
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

/** Parse one contract event into a taker-perspective fill summary, or null for other topics. */
export function parseFillEvent(event: rpc.Api.EventResponse): Fill | null {
  const topic = scValToNative(event.topic[0]) as string;
  if (topic !== "filled") return null;
  const f = scValToNative(event.value) as unknown[];
  return {
    id: eventId(event),
    ledger: eventLedger(event),
    tx_hash: eventTxHash(event),
    asset_in: num(f[0]),
    amount_in: amt(f[1]),
    asset_out: num(f[2]),
    amount_out: amt(f[3]),
    owner_tag: hex(f[4]),
  };
}

interface ContractState {
  cursor?: string;
  acc: TreeEvent[];
  fills: Fill[];
  latestLedger?: number;
}

export interface ChainEventSnapshot {
  cursor?: string;
  treeEvents: TreeEvent[];
  fills: Fill[];
  latestLedger?: number;
}

export interface ChainEventCacheSnapshot extends ChainEventSnapshot {
  fatalError?: string;
}

export interface ChainEventCache {
  load(scope: string): Promise<ChainEventCacheSnapshot | undefined>;
  save(scope: string, snapshot: ChainEventCacheSnapshot): Promise<void>;
}

export interface ChainEventRecovery {
  /** Called only after falling back from a stale start ledger to the oldest retained RPC ledger. */
  validateReplay?: (events: TreeEvent[]) => Promise<void>;
}

type EventServer = Pick<rpc.Server, "getEvents">;

/** Stateful, incremental reader of a desk's note-tree events. Keeps a per-contract cursor and the
 * accumulated insertion-ordered list, so repeated `events()` calls only fetch new pages. Use as the
 * {@link LocalPathProvider} event source. */
export class ChainEventSource {
  private readonly server: EventServer;
  private readonly startLedger?: number;
  private readonly state = new Map<string, ContractState>();
  private readonly logger: MosaicLogger;
  private readonly cache?: ChainEventCache;
  private readonly cacheKey: (contractId: string) => string;
  private readonly activity: ActivityHistory;

  constructor(opts: {
    network: NetworkConfig;
    startLedger?: number;
    logger?: MosaicLogger;
    cache?: ChainEventCache;
    cacheKey?: (contractId: string) => string;
    server?: EventServer;
    activity?: ActivityStore;
  }) {
    this.server = opts.server ?? new rpc.Server(opts.network.rpcUrl);
    this.startLedger = opts.startLedger;
    this.logger = opts.logger ?? getMosaicLogger();
    this.cache = opts.cache;
    this.cacheKey = opts.cacheKey ?? ((contractId) => `${opts.network.networkPassphrase}\u0000${contractId}`);
    this.activity = new ActivityHistory(opts.activity);
  }

  /** Fetch any new events for a contract and return the full insertion-ordered tree-event list. */
  async events(contractId: string, startLedger?: number, recovery?: ChainEventRecovery): Promise<TreeEvent[]> {
    const st = await this.loadState(contractId);
    const filters = [{ type: "contract" as const, contractIds: [contractId] }];
    try {
      await this.fetchPages(contractId, st, filters, startLedger ?? this.startLedger);
    } catch (error) {
      const range = parseLedgerRangeError(error);
      if (range && !st.cursor) {
        await this.recoverFromRetainedRange(contractId, st, filters, range.oldest, recovery);
        return st.acc;
      }
      this.logger.error("chain events fetch failed", { contractId, error });
      throw error;
    }
    return st.acc;
  }

  /** Fetch any new events for a contract and return informational fills in emission order. */
  async fills(contractId: string, startLedger?: number, recovery?: ChainEventRecovery): Promise<Fill[]> {
    await this.events(contractId, startLedger, recovery);
    return [...(this.state.get(contractId)?.fills ?? [])];
  }

  /** Fetch all currently available parsed events for a contract and return a coherent snapshot. */
  async snapshot(contractId: string, startLedger?: number, recovery?: ChainEventRecovery): Promise<ChainEventSnapshot> {
    await this.events(contractId, startLedger, recovery);
    const st = this.state.get(contractId);
    return {
      cursor: st?.cursor,
      treeEvents: [...(st?.acc ?? [])],
      fills: [...(st?.fills ?? [])],
      latestLedger: st?.latestLedger,
    };
  }

  private async loadState(contractId: string): Promise<ContractState> {
    const existing = this.state.get(contractId);
    if (existing) return existing;
    const scope = this.cacheKey(contractId);
    const cached = await this.cache?.load(scope);
    if (cached?.fatalError) throw new Error(cached.fatalError);
    const st: ContractState = {
      cursor: cached?.cursor,
      acc: [...(cached?.treeEvents ?? [])],
      fills: [...(cached?.fills ?? [])],
      latestLedger: cached?.latestLedger,
    };
    this.state.set(contractId, st);
    return st;
  }

  private async persist(contractId: string, st: ContractState, fatalError?: string): Promise<void> {
    await this.cache?.save(this.cacheKey(contractId), {
      cursor: st.cursor,
      treeEvents: [...st.acc],
      fills: [...st.fills],
      latestLedger: st.latestLedger,
      fatalError,
    });
  }

  private async fetchPages(
    contractId: string,
    st: ContractState,
    filters: { type: "contract"; contractIds: string[] }[],
    startLedger?: number,
  ): Promise<void> {
    const seen = new Set<string>();
    for (;;) {
      let page: rpc.Api.GetEventsResponse;
      const beforeTree = st.acc.length;
      const beforeFills = st.fills.length;
      if (st.cursor) {
        this.logger.debug("chain events fetch page", { contractId, cursor: st.cursor });
        page = await this.server.getEvents({ filters, cursor: st.cursor, limit: 1000 });
      } else {
        if (startLedger === undefined) {
          throw new Error("ChainEventSource needs a startLedger for the first read of a contract");
        }
        this.logger.debug("chain events fetch from ledger", { contractId, startLedger });
        page = await this.server.getEvents({ filters, startLedger, limit: 1000 });
      }
      for (const ev of page.events) {
        const id = eventId(ev);
        if (seen.has(id)) continue;
        seen.add(id);
        const t = parseTreeEvent(ev);
        if (t) st.acc.push(t);
        const fill = parseFillEvent(ev);
        if (fill) st.fills.push(fill);
        await this.recordChainEvent(contractId, ev, t, fill);
      }
      st.cursor = page.cursor;
      st.latestLedger = page.latestLedger;
      await this.persist(contractId, st);
      this.logger.debug("chain events page fetched", {
        contractId,
        ledger: page.latestLedger,
        eventCount: page.events.length,
        treeEvents: st.acc.length - beforeTree,
        fills: st.fills.length - beforeFills,
        cursor: st.cursor,
      });
      if (page.events.length < 1000) break;
    }
  }

  private async recoverFromRetainedRange(
    contractId: string,
    st: ContractState,
    filters: { type: "contract"; contractIds: string[] }[],
    oldestRetainedLedger: number,
    recovery?: ChainEventRecovery,
  ): Promise<void> {
    if (st.acc.length > 0 || st.fills.length > 0) {
      this.logger.info("chain events recovered from cached history", { contractId, cursor: st.cursor });
      await this.fetchPages(contractId, st, filters, oldestRetainedLedger);
      return;
    }
    this.logger.warn("chain events start ledger is outside RPC retention; attempting retained-window replay", {
      contractId,
      oldestRetainedLedger,
    });
    if (!recovery?.validateReplay) {
      const message = `trustless note history unavailable: RPC no longer retains the desk's full note-event history`;
      await this.persist(contractId, st, `${message}; no replay validator was configured`);
      throw new Error(`${message}; no replay validator was configured`);
    }
    await this.fetchPages(contractId, st, filters, oldestRetainedLedger);
    try {
      await recovery.validateReplay([...st.acc]);
    } catch (error) {
      const message = `trustless note history unavailable: RPC no longer retains the desk's full note-event history`;
      await this.persist(contractId, st, `${message}; ${errorMessage(error)}`);
      throw new Error(`${message}; ${errorMessage(error)}`);
    }
  }

  private async recordChainEvent(
    contractId: string,
    event: rpc.Api.EventResponse,
    treeEvent: TreeEvent | null,
    fill: Fill | null,
  ): Promise<void> {
    const id = eventId(event);
    const ledger = eventLedger(event);
    const txHash = eventTxHash(event);
    const topic = eventTopic(event);
    await this.activity
      .record({
        kind: "contract_event",
        idempotency_key: `contract-event:${contractId}:${id}`,
        contract_id: contractId,
        tx_hash: txHash || undefined,
        status: topic,
        metadata: {
          event_id: id,
          ledger,
          topic,
          tree_event: treeEvent ?? undefined,
        },
      })
      .catch((error) => this.logger.debug("contract activity record failed", { contractId, error }));
    if (fill) {
      await this.activity
        .record({
          kind: "fill",
          idempotency_key: `fill:${contractId}:${fill.id}`,
          contract_id: contractId,
          tx_hash: fill.tx_hash,
          owner_tag: fill.owner_tag,
          status: "filled",
          metadata: { ...fill },
        })
        .catch((error) => this.logger.debug("fill activity record failed", { contractId, error }));
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface LedgerRange {
  oldest: number;
  latest: number;
}

export function parseLedgerRange(message: string): LedgerRange | null {
  const after = message.split("ledger range:").at(1);
  if (!after) return null;
  const nums = after
    .split(/\D+/)
    .filter(Boolean)
    .map((value) => Number(value))
    .filter(Number.isSafeInteger);
  if (nums.length < 2) return null;
  return { oldest: nums[0], latest: nums[1] };
}

export function parseLedgerRangeError(error: unknown): LedgerRange | null {
  return parseLedgerRange(errorMessage(error));
}
