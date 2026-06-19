// Browser-local private note store (IndexedDB). Secrets (sk, rho) never leave the device.
// Each note is the wallet's own record of value it can later spend (order / unshield).
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export type NoteRole = 'asset' | 'order-output' | 'order-cancel'
export type NoteStatus = 'pending' | 'confirmed' | 'spent'

export interface Note {
  id: string
  deskId: string
  role: NoteRole
  asset_id: number
  symbol: string
  amount: string // i128 as decimal string
  sk: string // owner secret (0x field)
  rho: string // per-note randomness (0x field)
  owner_tag: string // 0x field, public
  status: NoteStatus
  leaf_index?: number
  txHash?: string
  createdAt: number
}

interface MosaicDB extends DBSchema {
  notes: {
    key: string
    value: Note
    indexes: { 'by-desk': string }
  }
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

export async function addNote(n: Note): Promise<void> {
  await (await db()).put('notes', n)
}

export async function notesForDesk(deskId: string): Promise<Note[]> {
  const all = await (await db()).getAllFromIndex('notes', 'by-desk', deskId)
  return all.sort((a, b) => b.createdAt - a.createdAt)
}

export async function updateNote(id: string, patch: Partial<Note>): Promise<void> {
  const d = await db()
  const cur = await d.get('notes', id)
  if (cur) await d.put('notes', { ...cur, ...patch })
}
