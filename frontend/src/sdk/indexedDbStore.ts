// Browser NoteStore adapter for @mosaic/sdk's NoteManager, backed by the SAME IndexedDB schema the
// app has always used (db "mosaic", store "notes", index "by-desk"). So the SDK client and the
// existing app share one note database. Secrets never leave the device.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Note, NoteStore } from '@mosaic/sdk'

interface MosaicDB extends DBSchema {
  notes: { key: string; value: Note; indexes: { 'by-desk': string } }
}

let dbp: Promise<IDBPDatabase<MosaicDB>> | null = null
function db() {
  if (!dbp) {
    dbp = openDB<MosaicDB>('mosaic', 1, {
      upgrade(d) {
        const s = d.createObjectStore('notes', { keyPath: 'id' })
        s.createIndex('by-desk', 'deskId')
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
