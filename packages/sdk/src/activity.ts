import { nowMs } from "./time.js";
import type { OperationEvent } from "./types.js";

export type ActivityEventKind =
  | "user_action"
  | "transaction"
  | "backend_operation"
  | "contract_event"
  | "fill"
  | "note_indexed"
  | "error";

export interface ActivityEvent {
  cursor?: number;
  id?: string;
  idempotency_key?: string;
  kind: ActivityEventKind;
  status?: string;
  message?: string;
  wallet_address?: string;
  network?: string;
  desk_id?: string;
  operation_id?: string;
  action?: string;
  contract_id?: string;
  method?: string;
  tx_hash?: string;
  note_id?: string;
  owner_tag?: string;
  created_at?: number;
  metadata?: Record<string, unknown>;
}

export interface ActivityQuery {
  kind?: ActivityEventKind | ActivityEventKind[];
  walletAddress?: string;
  deskId?: string;
  operationId?: string;
  txHash?: string;
  noteId?: string;
  from?: number;
  to?: number;
  limit?: number;
}

export interface ActivityStore {
  record(event: ActivityEvent): Promise<ActivityEvent>;
  list(query?: ActivityQuery): Promise<ActivityEvent[]>;
  since(cursorOrTime: number, query?: ActivityQuery): Promise<ActivityEvent[]>;
}

const BLOCKED_METADATA_KEYS = new Set([
  "sk",
  "rho",
  "proof",
  "proof_b64",
  "proofb64",
  "witness",
  "private",
  "privatekey",
  "private_key",
  "secret",
  "secretkey",
  "secret_key",
  "signedxdr",
  "signed_xdr",
  "xdr",
  "tx_xdr",
  "ciphertext",
  "ciphertext_b64",
  "nonce",
  "nonce_b64",
]);

function eventId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `activity-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return value;
  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
    return { type: "bytes", length: value.byteLength };
  }
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map(sanitizeValue);
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (BLOCKED_METADATA_KEYS.has(key.toLowerCase())) continue;
    out[key] = sanitizeValue(inner);
  }
  return out;
}

export function sanitizeActivityMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return sanitizeValue(metadata) as Record<string, unknown>;
}

export function normalizeActivityEvent(event: ActivityEvent): ActivityEvent {
  return {
    ...event,
    id: event.id ?? event.idempotency_key ?? eventId(),
    created_at: event.created_at ?? nowMs(),
    metadata: sanitizeActivityMetadata(event.metadata),
  };
}

export function matchesActivityQuery(event: ActivityEvent, query: ActivityQuery = {}): boolean {
  if (query.kind) {
    const kinds = Array.isArray(query.kind) ? query.kind : [query.kind];
    if (!kinds.includes(event.kind)) return false;
  }
  if (query.walletAddress && event.wallet_address !== query.walletAddress) return false;
  if (query.deskId && event.desk_id !== query.deskId) return false;
  if (query.operationId && event.operation_id !== query.operationId) return false;
  if (query.txHash && event.tx_hash !== query.txHash) return false;
  if (query.noteId && event.note_id !== query.noteId) return false;
  if (query.from !== undefined && (event.created_at ?? 0) < query.from) return false;
  if (query.to !== undefined && (event.created_at ?? 0) > query.to) return false;
  return true;
}

export function isActivityTimeCursor(value: number): boolean {
  return value >= 1_000_000_000_000;
}

export class NullActivityStore implements ActivityStore {
  async record(event: ActivityEvent): Promise<ActivityEvent> {
    return normalizeActivityEvent(event);
  }
  async list(): Promise<ActivityEvent[]> {
    return [];
  }
  async since(): Promise<ActivityEvent[]> {
    return [];
  }
}

export class ActivityHistory {
  private readonly store: ActivityStore;

  constructor(store: ActivityStore = new NullActivityStore()) {
    this.store = store;
  }

  record(event: ActivityEvent): Promise<ActivityEvent> {
    return this.store.record(event);
  }

  list(query?: ActivityQuery): Promise<ActivityEvent[]> {
    return this.store.list(query);
  }

  since(cursorOrTime: number, query?: ActivityQuery): Promise<ActivityEvent[]> {
    return this.store.since(cursorOrTime, query);
  }

  async ingestOperationEvents(events: OperationEvent[], base: Partial<ActivityEvent> = {}): Promise<ActivityEvent[]> {
    const out: ActivityEvent[] = [];
    for (const event of events) {
      const details = sanitizeActivityMetadata(
        event.details && typeof event.details === "object"
          ? (event.details as Record<string, unknown>)
          : { details: event.details },
      );
      out.push(
        await this.record({
          ...base,
          kind: "backend_operation",
          idempotency_key: `backend-operation:${event.cursor}`,
          operation_id: event.operation_id,
          status: event.state,
          message: event.message,
          tx_hash: txHashFromDetails(details),
          created_at: event.created_at,
          metadata: {
            cursor: event.cursor,
            event_type: event.event_type,
            details,
          },
        }),
      );
    }
    return out;
  }
}

function txHashFromDetails(details?: Record<string, unknown>): string | undefined {
  const candidates = [
    details?.txHash,
    details?.tx_hash,
    details?.transaction,
    details?.result && typeof details.result === "object"
      ? (details.result as Record<string, unknown>).txHash ?? (details.result as Record<string, unknown>).tx_hash
      : undefined,
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.length > 0);
}
