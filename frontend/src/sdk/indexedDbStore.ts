// Browser NoteStore adapter for @mosaic/sdk's NoteManager, backed by the SAME IndexedDB schema the
// app has always used (db "mosaic", store "notes", index "by-desk"). So the SDK client and the
// existing app share one note database. Secrets never leave the device.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import {
  isActivityTimeCursor,
  matchesActivityQuery,
  normalizeActivityEvent,
  type ActivityEvent,
  type ActivityQuery,
  type ActivityStore,
  type ChainEventCache,
  type ChainEventCacheSnapshot,
  type Desk,
  type Note,
  type NoteStore,
} from '@mosaic/sdk'

interface MosaicDB extends DBSchema {
  notes: { key: string; value: Note; indexes: { 'by-desk': string } }
  desks: { key: string; value: Desk }
  eventCaches: { key: string; value: ChainEventCacheSnapshot & { scope: string } }
  activityEvents: {
    key: number
    value: ActivityEvent
    indexes: {
      'by-id': string
      'by-idempotency': string
      'by-kind': string
      'by-wallet': string
      'by-desk': string
      'by-operation': string
      'by-tx': string
      'by-note': string
      'by-created': number
    }
  }
}

let dbp: Promise<IDBPDatabase<MosaicDB>> | null = null
function db() {
  if (!dbp) {
    dbp = openDB<MosaicDB>('mosaic', 4, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          const s = d.createObjectStore('notes', { keyPath: 'id' })
          s.createIndex('by-desk', 'deskId')
        }
        if (oldVersion < 2) {
          d.createObjectStore('desks', { keyPath: 'id' })
        }
        if (oldVersion < 3) {
          d.createObjectStore('eventCaches', { keyPath: 'scope' })
        }
        if (oldVersion < 4) {
          const s = d.createObjectStore('activityEvents', { keyPath: 'cursor', autoIncrement: true })
          s.createIndex('by-id', 'id', { unique: true })
          s.createIndex('by-idempotency', 'idempotency_key', { unique: true })
          s.createIndex('by-kind', 'kind')
          s.createIndex('by-wallet', 'wallet_address')
          s.createIndex('by-desk', 'desk_id')
          s.createIndex('by-operation', 'operation_id')
          s.createIndex('by-tx', 'tx_hash')
          s.createIndex('by-note', 'note_id')
          s.createIndex('by-created', 'created_at')
        }
      },
    })
  }
  return dbp
}

export class IndexedDbStore implements NoteStore, ActivityStore {
  async get(id: string): Promise<Note | undefined> {
    return (await db()).get('notes', id)
  }
  async put(note: Note): Promise<void> {
    await (await db()).put('notes', note)
  }
  async delete(id: string): Promise<void> {
    await (await db()).delete('notes', id)
  }
  async all(): Promise<Note[]> {
    return (await db()).getAll('notes')
  }
  async byDesk(deskId: string): Promise<Note[]> {
    return (await db()).getAllFromIndex('notes', 'by-desk', deskId)
  }

  async record(event: ActivityEvent): Promise<ActivityEvent> {
    const database = await db()
    if (event.idempotency_key) {
      const existing = await database.getFromIndex('activityEvents', 'by-idempotency', event.idempotency_key)
      if (existing) return existing
    }
    const stored = normalizeActivityEvent(event)
    if (stored.id) {
      const existing = await database.getFromIndex('activityEvents', 'by-id', stored.id)
      if (existing) return existing
    }
    const cursor = Number(await database.add('activityEvents', stored))
    const withCursor = { ...stored, cursor }
    await database.put('activityEvents', withCursor)
    return withCursor
  }

  async list(query: ActivityQuery = {}): Promise<ActivityEvent[]> {
    const events = (await (await db()).getAll('activityEvents'))
      .filter((event) => matchesActivityQuery(event, query))
      .sort((a, b) => (a.cursor ?? 0) - (b.cursor ?? 0))
    return query.limit ? events.slice(0, query.limit) : events
  }

  async since(cursorOrTime: number, query: ActivityQuery = {}): Promise<ActivityEvent[]> {
    const events = await this.list(query)
    return events.filter((event) =>
      isActivityTimeCursor(cursorOrTime)
        ? (event.created_at ?? 0) > cursorOrTime
        : (event.cursor ?? 0) > cursorOrTime,
    )
  }
}

export class IndexedDbEventCache implements ChainEventCache {
  async load(scope: string): Promise<ChainEventCacheSnapshot | undefined> {
    const record = await (await db()).get('eventCaches', scope)
    if (!record) return undefined
    return {
      cursor: record.cursor,
      treeEvents: record.treeEvents,
      fills: record.fills,
      latestLedger: record.latestLedger,
      fatalError: record.fatalError,
    }
  }

  async save(scope: string, snapshot: ChainEventCacheSnapshot): Promise<void> {
    await (await db()).put('eventCaches', { scope, ...snapshot })
  }
}

export const browserEventCache = new IndexedDbEventCache()
export const browserActivityStore = new IndexedDbStore()

export async function listLocalDesks(): Promise<Desk[]> {
  return (await db()).getAll('desks')
}

export async function getLocalDesk(id: string): Promise<Desk | undefined> {
  return (await db()).get('desks', id)
}

export async function hasLocalDesk(id: string): Promise<boolean> {
  return !!(await getLocalDesk(id))
}

export async function putLocalDesk(desk: Desk): Promise<void> {
  await (await db()).put('desks', desk)
}
