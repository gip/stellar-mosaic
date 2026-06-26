// In-memory {@link NoteStore} — the zero-dependency adapter used by tests and as a fallback when no
// durable storage is configured. Browser uses IndexedDbStorage; Node uses SqliteStorage.

import type { NoteStore } from "./ports.js";
import type { Note } from "./types.js";

export class MemoryStore implements NoteStore {
  private readonly notes = new Map<string, Note>();

  async get(id: string): Promise<Note | undefined> {
    return this.notes.get(id);
  }
  async put(note: Note): Promise<void> {
    this.notes.set(note.id, { ...note });
  }
  async delete(id: string): Promise<void> {
    this.notes.delete(id);
  }
  async all(): Promise<Note[]> {
    return [...this.notes.values()].map((n) => ({ ...n }));
  }
  async byDesk(deskId: string): Promise<Note[]> {
    return [...this.notes.values()].filter((n) => n.deskId === deskId).map((n) => ({ ...n }));
  }
}
