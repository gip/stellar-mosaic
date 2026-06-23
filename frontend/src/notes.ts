// Browser-local private note store (IndexedDB). Secrets (sk, rho) never leave the device.
// Each note is the wallet's own record of value it can later spend (order / unshield).
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { nowMs } from './time'

export type NoteRole = 'asset' | 'order-output' | 'order-cancel'
export type NoteStatus = 'active' | 'spent' | 'cancelled'
export type RecoveryState = 'local-only' | 'staged' | 'protected' | 'sync-error'

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
  // WS4: the rest of the order's terms, so the cancel circuit can recompute order_leaf to prove
  // membership in the order tree (the leaf binds all of these).
  asset_out: number
  min_out: string
  output_owner_tag: string
  expiry: number
  partial_allowed: boolean
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
  /** Per-note mint nonce (0x field). owner_tag = compress(compress(compress(sk,0),rho),nonce) and
   * nullifier = compress(sk, compress(rho, nonce)). Wallet-minted notes (shield, cancel return, join
   * outputs) use '0'; a proceeds note minted by a match carries nonce = compress(match_id, slot).
   * Absent on pre-WS4 records (treated as '0'). */
  nonce?: string
  owner_tag: string // 0x field, public
  status: NoteStatus
  indexed: boolean // whether the note has appeared in the indexer and can be spent
  leaf_index?: number
  txHash?: string
  createdAt: number
  updatedAt?: number // last mutation (status promotion, fill, cancel); falls back to createdAt
  cancel?: OrderCancelInfo // present on order-output notes for a still-cancellable resting order
  cancelledAt?: number // set once the order has been cancelled
  /** Absent on pre-recovery records. Those records intentionally remain local-only. */
  wallet_address?: string
  recovery_version?: 1
  recovery_state?: RecoveryState
  revision?: number
  /** Durable private-wallet journal fields. The backend sees only the operation id, never this
   * note, its secrets, or its ownership metadata. */
  operation_id?: string
  operation_state?: 'reserved' | 'pending-output' | 'committed'
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
  await (await db()).put('notes', {
    ...n,
    revision: n.revision ?? 1,
    updatedAt: n.updatedAt ?? n.createdAt,
  })
  announceNotesChanged()
}

export async function notesForDesk(deskId: string, walletAddress?: string | null): Promise<Note[]> {
  const all = await allNotesForDesk(deskId)
  return all
    .filter((n) => !n.wallet_address || n.wallet_address === walletAddress)
    .sort((a, b) => b.createdAt - a.createdAt)
}

async function allNotesForDesk(deskId: string): Promise<Note[]> {
  const all = await (await db()).getAllFromIndex('notes', 'by-desk', deskId)
  return all.map(normalizeNote)
}

export async function updateNote(id: string, patch: Partial<Note>): Promise<void> {
  const d = await db()
  const cur = await d.get('notes', id)
  if (cur) {
    const note = normalizeNote(cur)
    await d.put('notes', {
      ...note,
      ...patch,
      revision: (note.revision ?? 0) + 1,
      updatedAt: nowMs(),
    })
    announceNotesChanged()
  }
}

export async function removeNote(id: string): Promise<void> {
  await (await db()).delete('notes', id)
  announceNotesChanged()
}

export async function recoveryNotes(walletAddress: string): Promise<Note[]> {
  const all = await (await db()).getAll('notes')
  return all
    .map(normalizeNote)
    .filter((n) => n.wallet_address === walletAddress && n.recovery_version === 1)
}

export async function markRecoveryProtected(walletAddress: string): Promise<void> {
  const d = await db()
  const tx = d.transaction('notes', 'readwrite')
  let cursor = await tx.store.openCursor()
  while (cursor) {
    const n = normalizeNote(cursor.value)
    if (n.wallet_address === walletAddress && n.recovery_version === 1 && n.recovery_state !== 'protected') {
      await cursor.update({ ...n, recovery_state: 'protected' })
    }
    cursor = await cursor.continue()
  }
  await tx.done
  announceNotesChanged()
}

/** Merge a decrypted snapshot into IndexedDB. Legacy records without wallet_address are untouched. */
export async function mergeRecoveryNotes(walletAddress: string, incoming: Note[]): Promise<void> {
  const d = await db()
  const tx = d.transaction('notes', 'readwrite')
  for (const raw of incoming) {
    if (raw.wallet_address !== walletAddress || raw.recovery_version !== 1) continue
    const remote = normalizeNote({ ...raw, recovery_state: 'protected' })
    const currentRaw = await tx.store.get(remote.id)
    if (!currentRaw) {
      await tx.store.put(remote)
      continue
    }
    const current = normalizeNote(currentRaw)
    if (current.wallet_address && current.wallet_address !== walletAddress) continue
    await tx.store.put(mergeNote(current, remote))
  }
  await tx.done
  announceNotesChanged()
}

function mergeNote(a: Note, b: Note): Note {
  const ar = a.revision ?? 0
  const br = b.revision ?? 0
  const newer = br > ar || (br === ar && (b.updatedAt ?? b.createdAt) > (a.updatedAt ?? a.createdAt)) ? b : a
  const other = newer === a ? b : a
  // Lifecycle and indexer readiness are monotonic even when two devices race on a stale snapshot.
  const terminal = [a, b].find((n) => n.status === 'spent' || n.status === 'cancelled')
  return {
    ...other,
    ...newer,
    status: terminal?.status ?? newer.status,
    indexed: a.indexed || b.indexed,
    recovery_state: 'protected',
    revision: Math.max(ar, br),
    updatedAt: Math.max(a.updatedAt ?? a.createdAt, b.updatedAt ?? b.createdAt),
  }
}

/** Read records written by the previous pending/confirmed/spent status model without requiring
 * users to clear IndexedDB. Pending/confirmed described indexer readiness, which now lives in the
 * separate `indexed` field; lifecycle status is always active/spent/cancelled. */
function normalizeNote(raw: Note): Note {
  const legacy = raw as unknown as Omit<Note, 'status' | 'indexed'> & {
    status: NoteStatus | 'pending' | 'confirmed'
    indexed?: boolean
  }
  const status: NoteStatus = legacy.cancelledAt
    ? 'cancelled'
    : legacy.status === 'spent'
      ? 'spent'
      : legacy.status === 'cancelled'
        ? 'cancelled'
        : 'active'
  const indexed = legacy.indexed ?? legacy.status === 'confirmed'
  return {
    ...legacy,
    status,
    indexed,
    recovery_state: legacy.recovery_state ?? (legacy.wallet_address ? 'protected' : 'local-only'),
    revision: legacy.revision ?? 0,
  }
}

/**
 * Reconcile local notes against the on-chain note set (matched by owner_tag): stamp leaf_index,
 * mark the note indexed, and replace an estimated output amount with its real on-chain amount.
 * Returns true if anything changed.
 */
export async function reconcile(
  deskId: string,
  chain: { leaf_index: number; amount: string; owner_tag: string }[],
): Promise<boolean> {
  const byTag = new Map(chain.map((c) => [c.owner_tag.toLowerCase(), c]))
  const local = await allNotesForDesk(deskId)
  let changed = false
  for (const n of local) {
    if (n.status === 'cancelled') continue // cancelled order: no fill will arrive
    const c = byTag.get(n.owner_tag.toLowerCase())
    if (!c) continue
    const patch: Partial<Note> = {}
    if (n.leaf_index !== c.leaf_index) patch.leaf_index = c.leaf_index
    if (!n.indexed) {
      patch.indexed = true
      patch.amount = c.amount
    }
    if (Object.keys(patch).length) {
      await updateNote(n.id, patch)
      changed = true
    }
  }
  return changed
}

function announceNotesChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('mosaic-notes-changed'))
}
