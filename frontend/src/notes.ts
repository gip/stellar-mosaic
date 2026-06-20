// Browser-local private note store (IndexedDB). Secrets (sk, rho) never leave the device.
// Each note is the wallet's own record of value it can later spend (order / unshield).
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export type NoteRole = 'asset' | 'order-output' | 'order-cancel'
export type NoteStatus = 'pending' | 'confirmed' | 'spent'

/** Secrets + identifiers an order's maker needs to later prove cancel authority and reclaim the
 * locked funds. Carried on the order-output (proceeds) note created when the order is placed. */
export interface OrderCancelInfo {
  rho_ord: string // cancel randomness (cancel_owner_tag = compress(compress(sk,0), rho_ord))
  order_leaf: string // identifies the resting order on-chain
  cancel_owner_tag: string // cancel-authority tag stored in the book entry
  pairId: number
  side: number // SELL=1 / BUY=0 (matches the submit side)
  asset_in: number // locked/offered asset — the refund is minted in this asset
  symbol_in: string
  amount_in: string // principal offered; the refund note's initial amount
}

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
  cancel?: OrderCancelInfo // present on order-output notes for a still-cancellable resting order
  cancelledAt?: number // set once the order has been cancelled
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

/**
 * Reconcile local notes against the on-chain note set (matched by owner_tag): stamp leaf_index,
 * and promote a pending proceeds note to confirmed with its real filled amount once it appears.
 * Returns true if anything changed.
 */
export async function reconcile(
  deskId: string,
  chain: { leaf_index: number; amount: string; owner_tag: string }[],
): Promise<boolean> {
  const byTag = new Map(chain.map((c) => [c.owner_tag.toLowerCase(), c]))
  const local = await notesForDesk(deskId)
  let changed = false
  for (const n of local) {
    if (n.cancelledAt) continue // cancelled order: no fill will arrive, don't promote it
    const c = byTag.get(n.owner_tag.toLowerCase())
    if (!c) continue
    const patch: Partial<Note> = {}
    if (n.leaf_index !== c.leaf_index) patch.leaf_index = c.leaf_index
    if (n.status === 'pending') {
      patch.status = 'confirmed'
      patch.amount = c.amount
    }
    if (Object.keys(patch).length) {
      await updateNote(n.id, patch)
      changed = true
    }
  }
  return changed
}
