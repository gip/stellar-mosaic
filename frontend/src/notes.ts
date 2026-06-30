// Browser-local private note store. The lifecycle logic (normalize / merge / reconcile / revision
// bumping) now lives in @mosaic/sdk's NoteManager (single source of truth, unit-tested); this module
// wires it to the app's IndexedDB store and re-exports the same function surface so existing imports
// of './notes' keep working unchanged. Secrets (sk, rho) never leave the device.
import { NoteManager } from '@mosaic/sdk'
import type { ChainNote, Note } from '@mosaic/sdk'
import { IndexedDbStore } from './sdk/indexedDbStore'
import type { StorageMode } from './StorageModeContext'

export type { Note, NoteRole, NoteStatus, RecoveryState, OrderCancelInfo, ChainNote } from '@mosaic/sdk'

const managers = new Map<StorageMode, NoteManager>()

function managerFor(mode: StorageMode): NoteManager {
  let manager = managers.get(mode)
  if (!manager) {
    manager = new NoteManager(new IndexedDbStore(mode), () => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('mosaic-notes-changed', { detail: { mode } }))
      }
    })
    managers.set(mode, manager)
  }
  return manager
}

export const addNote = (mode: StorageMode, note: Note): Promise<void> => managerFor(mode).add(note)
export const notesForDesk = (mode: StorageMode, deskId: string, walletAddress?: string | null): Promise<Note[]> =>
  managerFor(mode).forDesk(deskId, walletAddress)
export const updateNote = (mode: StorageMode, id: string, patch: Partial<Note>): Promise<void> =>
  managerFor(mode).update(id, patch)
export const removeNote = (mode: StorageMode, id: string): Promise<void> => managerFor(mode).remove(id)
export const recoveryNotes = (mode: StorageMode, walletAddress: string): Promise<Note[]> =>
  managerFor(mode).recoveryNotes(walletAddress)
export const markRecoveryProtected = (mode: StorageMode, walletAddress: string): Promise<void> =>
  managerFor(mode).markRecoveryProtected(walletAddress)
export const mergeRecoveryNotes = (mode: StorageMode, walletAddress: string, incoming: Note[]): Promise<void> =>
  managerFor(mode).mergeRecoveryNotes(walletAddress, incoming)
export const reconcile = (mode: StorageMode, deskId: string, chain: ChainNote[]): Promise<boolean> =>
  managerFor(mode).reconcile(deskId, chain)
