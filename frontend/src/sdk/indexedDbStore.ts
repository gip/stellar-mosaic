// Browser NoteStore adapter for @mosaic/sdk's NoteManager, backed by the SAME IndexedDB schema the
// app has always used (db "mosaic", store "notes", index "by-desk"). So the SDK client and the
// existing app share one note database. Secrets never leave the device.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import {
  type CatalogAsset,
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
import type { StorageMode } from '../StorageModeContext'

interface MosaicDB extends DBSchema {
  notes: { key: string; value: Note; indexes: { 'by-desk': string } }
  desks: { key: string; value: Desk }
  catalogAssets: { key: string; value: CatalogAsset }
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

const dbPromises = new Map<StorageMode, Promise<IDBPDatabase<MosaicDB>>>()

export function indexedDbName(mode: StorageMode): string {
  return `mosaic-${mode}`
}

function db(mode: StorageMode) {
  let dbp = dbPromises.get(mode)
  if (!dbp) {
    dbp = openDB<MosaicDB>(indexedDbName(mode), 5, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          const s = d.createObjectStore('notes', { keyPath: 'id' })
          s.createIndex('by-desk', 'deskId')
        }
        if (oldVersion < 2) {
          d.createObjectStore('desks', { keyPath: 'id' })
        }
        if (oldVersion < 5) {
          if (!d.objectStoreNames.contains('catalogAssets')) {
            d.createObjectStore('catalogAssets', { keyPath: 'id' })
          }
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
    dbPromises.set(mode, dbp)
  }
  return dbp
}

export class IndexedDbStore implements NoteStore, ActivityStore {
  private readonly mode: StorageMode

  constructor(mode: StorageMode = 'trustless') {
    this.mode = mode
  }

  async get(id: string): Promise<Note | undefined> {
    return (await db(this.mode)).get('notes', id)
  }
  async put(note: Note): Promise<void> {
    await (await db(this.mode)).put('notes', note)
  }
  async delete(id: string): Promise<void> {
    await (await db(this.mode)).delete('notes', id)
  }
  async all(): Promise<Note[]> {
    return (await db(this.mode)).getAll('notes')
  }
  async byDesk(deskId: string): Promise<Note[]> {
    return (await db(this.mode)).getAllFromIndex('notes', 'by-desk', deskId)
  }

  async record(event: ActivityEvent): Promise<ActivityEvent> {
    const database = await db(this.mode)
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
    const events = (await (await db(this.mode)).getAll('activityEvents'))
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
  private readonly mode: StorageMode

  constructor(mode: StorageMode = 'trustless') {
    this.mode = mode
  }

  async load(scope: string): Promise<ChainEventCacheSnapshot | undefined> {
    const record = await (await db(this.mode)).get('eventCaches', scope)
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
    await (await db(this.mode)).put('eventCaches', { scope, ...snapshot })
  }
}

export function browserEventCache(mode: StorageMode): IndexedDbEventCache {
  return new IndexedDbEventCache(mode)
}

export function browserActivityStore(mode: StorageMode): IndexedDbStore {
  return new IndexedDbStore(mode)
}

export async function listLocalDesks(mode: StorageMode): Promise<Desk[]> {
  return (await db(mode)).getAll('desks')
}

export async function getLocalDesk(mode: StorageMode, id: string): Promise<Desk | undefined> {
  return (await db(mode)).get('desks', id)
}

export async function hasLocalDesk(mode: StorageMode, id: string): Promise<boolean> {
  return !!(await getLocalDesk(mode, id))
}

export async function putLocalDesk(mode: StorageMode, desk: Desk): Promise<void> {
  await (await db(mode)).put('desks', desk)
}

export async function listLocalCatalogAssets(mode: StorageMode): Promise<CatalogAsset[]> {
  return (await db(mode)).getAll('catalogAssets')
}

export async function putLocalCatalogAsset(mode: StorageMode, asset: CatalogAsset): Promise<void> {
  await (await db(mode)).put('catalogAssets', asset)
}

export async function getLocalCatalogAsset(mode: StorageMode, id: string): Promise<CatalogAsset | undefined> {
  return (await db(mode)).get('catalogAssets', id)
}
