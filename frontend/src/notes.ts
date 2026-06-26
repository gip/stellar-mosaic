// Browser-local private note store. The lifecycle logic (normalize / merge / reconcile / revision
// bumping) now lives in @mosaic/sdk's NoteManager (single source of truth, unit-tested); this module
// wires it to the app's IndexedDB store and re-exports the same function surface so existing imports
// of './notes' keep working unchanged. Secrets (sk, rho) never leave the device.
import { NoteManager } from '@mosaic/sdk'
import type { ChainNote, Note } from '@mosaic/sdk'
import { IndexedDbStore } from './sdk/indexedDbStore'

export type { Note, NoteRole, NoteStatus, RecoveryState, OrderCancelInfo, ChainNote } from '@mosaic/sdk'

const manager = new NoteManager(new IndexedDbStore(), () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('mosaic-notes-changed'))
})

export const addNote = (note: Note): Promise<void> => manager.add(note)
export const notesForDesk = (deskId: string, walletAddress?: string | null): Promise<Note[]> =>
  manager.forDesk(deskId, walletAddress)
export const updateNote = (id: string, patch: Partial<Note>): Promise<void> => manager.update(id, patch)
export const removeNote = (id: string): Promise<void> => manager.remove(id)
export const recoveryNotes = (walletAddress: string): Promise<Note[]> => manager.recoveryNotes(walletAddress)
export const markRecoveryProtected = (walletAddress: string): Promise<void> =>
  manager.markRecoveryProtected(walletAddress)
export const mergeRecoveryNotes = (walletAddress: string, incoming: Note[]): Promise<void> =>
  manager.mergeRecoveryNotes(walletAddress, incoming)
export const reconcile = (deskId: string, chain: ChainNote[]): Promise<boolean> =>
  manager.reconcile(deskId, chain)
