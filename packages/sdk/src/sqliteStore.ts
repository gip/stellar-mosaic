// Durable {@link NoteStore} backed by Node's built-in `node:sqlite` (no native dependency). This is
// the default persistence for the CLI/agent so notes survive across runs. NOT exported from the
// core index (it imports a Node builtin); reach it via `@mosaic/sdk/node`.

import { DatabaseSync } from "node:sqlite";
import {
  isActivityTimeCursor,
  matchesActivityQuery,
  normalizeActivityEvent,
  type ActivityEvent,
  type ActivityQuery,
  type ActivityStore,
} from "./activity.js";
import type { NoteStore } from "./ports.js";
import type { Note } from "./types.js";

export class SqliteStore implements NoteStore, ActivityStore {
  private readonly db: DatabaseSync;

  /** Open (or create) the SQLite database at `path` (use ":memory:" for an ephemeral store). */
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, deskId TEXT, json TEXT)");
    this.db.exec("CREATE INDEX IF NOT EXISTS notes_desk ON notes(deskId)");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT UNIQUE,
        kind TEXT NOT NULL,
        wallet_address TEXT,
        desk_id TEXT,
        operation_id TEXT,
        tx_hash TEXT,
        note_id TEXT,
        created_at INTEGER NOT NULL,
        json TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS activity_events_created ON activity_events(created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS activity_events_filters ON activity_events(kind, wallet_address, desk_id, operation_id)");
  }

  async get(id: string): Promise<Note | undefined> {
    const row = this.db.prepare("SELECT json FROM notes WHERE id = ?").get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as Note) : undefined;
  }

  async put(note: Note): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO notes(id, deskId, json) VALUES(?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET deskId = excluded.deskId, json = excluded.json",
      )
      .run(note.id, note.deskId, JSON.stringify(note));
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  }

  async all(): Promise<Note[]> {
    return (this.db.prepare("SELECT json FROM notes").all() as { json: string }[]).map(
      (r) => JSON.parse(r.json) as Note,
    );
  }

  async byDesk(deskId: string): Promise<Note[]> {
    return (
      this.db.prepare("SELECT json FROM notes WHERE deskId = ?").all(deskId) as { json: string }[]
    ).map((r) => JSON.parse(r.json) as Note);
  }

  async record(event: ActivityEvent): Promise<ActivityEvent> {
    if (event.idempotency_key) {
      const existing = this.activityBy("idempotency_key", event.idempotency_key);
      if (existing) return existing;
    }
    const stored = normalizeActivityEvent(event);
    const storedId = stored.id ?? stored.idempotency_key ?? `activity-${Date.now()}`;
    const createdAt = stored.created_at ?? Date.now();
    const existing = this.activityBy("id", storedId);
    if (existing) return existing;
    const result = this.db
      .prepare(
        "INSERT INTO activity_events(id,idempotency_key,kind,wallet_address,desk_id,operation_id,tx_hash,note_id,created_at,json) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        storedId,
        stored.idempotency_key ?? null,
        stored.kind,
        stored.wallet_address ?? null,
        stored.desk_id ?? null,
        stored.operation_id ?? null,
        stored.tx_hash ?? null,
        stored.note_id ?? null,
        createdAt,
        JSON.stringify({ ...stored, id: storedId, created_at: createdAt }),
      );
    const withCursor = { ...stored, id: storedId, created_at: createdAt, cursor: Number(result.lastInsertRowid) };
    this.db
      .prepare("UPDATE activity_events SET json = ? WHERE cursor = ?")
      .run(JSON.stringify(withCursor), withCursor.cursor);
    return withCursor;
  }

  async list(query: ActivityQuery = {}): Promise<ActivityEvent[]> {
    const rows = this.activityRows(query);
    return rows.map((row) => JSON.parse(row.json) as ActivityEvent).filter((event) => matchesActivityQuery(event, query));
  }

  async since(cursorOrTime: number, query: ActivityQuery = {}): Promise<ActivityEvent[]> {
    const clause = isActivityTimeCursor(cursorOrTime) ? "created_at > ?" : "cursor > ?";
    const rows = this.activityRows(query, clause, [cursorOrTime]);
    return rows.map((row) => JSON.parse(row.json) as ActivityEvent).filter((event) => matchesActivityQuery(event, query));
  }

  private activityBy(column: "id" | "idempotency_key", value: string): ActivityEvent | undefined {
    const row = this.db.prepare(`SELECT json FROM activity_events WHERE ${column} = ?`).get(value) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as ActivityEvent) : undefined;
  }

  private activityRows(
    query: ActivityQuery,
    extraClause?: string,
    extraArgs: (string | number | null)[] = [],
  ): { json: string }[] {
    const clauses: string[] = [];
    const args: (string | number | null)[] = [];
    if (query.kind) {
      const kinds = Array.isArray(query.kind) ? query.kind : [query.kind];
      clauses.push(`kind IN (${kinds.map(() => "?").join(",")})`);
      args.push(...kinds);
    }
    if (query.walletAddress) {
      clauses.push("wallet_address = ?");
      args.push(query.walletAddress);
    }
    if (query.deskId) {
      clauses.push("desk_id = ?");
      args.push(query.deskId);
    }
    if (query.operationId) {
      clauses.push("operation_id = ?");
      args.push(query.operationId);
    }
    if (query.txHash) {
      clauses.push("tx_hash = ?");
      args.push(query.txHash);
    }
    if (query.noteId) {
      clauses.push("note_id = ?");
      args.push(query.noteId);
    }
    if (query.from !== undefined) {
      clauses.push("created_at >= ?");
      args.push(query.from);
    }
    if (query.to !== undefined) {
      clauses.push("created_at <= ?");
      args.push(query.to);
    }
    if (extraClause) {
      clauses.push(extraClause);
      args.push(...extraArgs);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const limit = query.limit && Number.isFinite(query.limit) ? ` LIMIT ${Math.max(0, Math.floor(query.limit))}` : "";
    return this.db.prepare(`SELECT json FROM activity_events${where} ORDER BY cursor${limit}`).all(...args) as {
      json: string;
    }[];
  }
}
