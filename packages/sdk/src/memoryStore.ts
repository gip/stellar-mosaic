// In-memory {@link NoteStore} — the zero-dependency adapter used by tests and as a fallback when no
// durable storage is configured. Browser uses IndexedDbStorage; Node uses SqliteStorage.

import {
  matchesActivityQuery,
  isActivityTimeCursor,
  normalizeActivityEvent,
  type ActivityEvent,
  type ActivityQuery,
  type ActivityStore,
} from "./activity.js";
import type { NoteStore } from "./ports.js";
import type { Note } from "./types.js";

export class MemoryStore implements NoteStore, ActivityStore {
  private readonly notes = new Map<string, Note>();
  private readonly events: ActivityEvent[] = [];
  private nextCursor = 1;

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

  async record(event: ActivityEvent): Promise<ActivityEvent> {
    if (event.idempotency_key) {
      const existing = this.events.find((item) => item.idempotency_key === event.idempotency_key);
      if (existing) return { ...existing };
    }
    const stored = normalizeActivityEvent({ ...event, cursor: this.nextCursor++ });
    this.events.push(stored);
    return { ...stored };
  }

  async list(query: ActivityQuery = {}): Promise<ActivityEvent[]> {
    const limit = query.limit ?? Number.POSITIVE_INFINITY;
    return this.events
      .filter((event) => matchesActivityQuery(event, query))
      .sort((a, b) => (a.cursor ?? 0) - (b.cursor ?? 0))
      .slice(0, limit)
      .map((event) => ({ ...event }));
  }

  async since(cursorOrTime: number, query: ActivityQuery = {}): Promise<ActivityEvent[]> {
    const events = await this.list(query);
    return events.filter((event) =>
      isActivityTimeCursor(cursorOrTime)
        ? (event.created_at ?? 0) > cursorOrTime
        : (event.cursor ?? 0) > cursorOrTime,
    );
  }
}
