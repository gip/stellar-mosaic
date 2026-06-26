// Durable {@link NoteStore} backed by Node's built-in `node:sqlite` (no native dependency). This is
// the default persistence for the CLI/agent so notes survive across runs. NOT exported from the
// core index (it imports a Node builtin); reach it via `@mosaic/sdk/node`.

import { DatabaseSync } from "node:sqlite";
import type { NoteStore } from "./ports.js";
import type { Note } from "./types.js";

export class SqliteStore implements NoteStore {
  private readonly db: DatabaseSync;

  /** Open (or create) the SQLite database at `path` (use ":memory:" for an ephemeral store). */
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, deskId TEXT, json TEXT)");
    this.db.exec("CREATE INDEX IF NOT EXISTS notes_desk ON notes(deskId)");
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
}
