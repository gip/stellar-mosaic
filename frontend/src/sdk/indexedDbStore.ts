// Browser NoteStore adapter for @mosaic/sdk's NoteManager, backed by the SAME IndexedDB schema the
// app has always used (db "mosaic", store "notes", index "by-desk"). So the SDK client and the
// existing app share one note database. Secrets never leave the device.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Desk, Note, NoteStore } from '@mosaic/sdk'

interface MosaicDB extends DBSchema {
  notes: { key: string; value: Note; indexes: { 'by-desk': string } }
  desks: { key: string; value: Desk }
}

let dbp: Promise<IDBPDatabase<MosaicDB>> | null = null
function db() {
  if (!dbp) {
    dbp = openDB<MosaicDB>('mosaic', 2, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          const s = d.createObjectStore('notes', { keyPath: 'id' })
          s.createIndex('by-desk', 'deskId')
        }
        if (oldVersion < 2) {
          d.createObjectStore('desks', { keyPath: 'id' })
        }
      },
    })
  }
  return dbp
}

export class IndexedDbStore implements NoteStore {
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
}

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
