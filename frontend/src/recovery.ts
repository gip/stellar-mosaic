import { openDB, type DBSchema } from 'idb'
import { Buffer } from 'buffer'
import { Keypair } from '@stellar/stellar-sdk'
import { errorMessage } from '@mosaic/sdk'
import { ApiError, api, type WalletBackupEnvelope } from './api'
import { signRecoveryMessage } from './wallet'
import {
  addNote,
  markRecoveryProtected,
  mergeRecoveryNotes,
  recoveryNotes,
  updateNote,
  type Note,
} from './notes'

export const RECOVERY_VERSION = 1 as const
const SIGNED_MESSAGE_PREFIX = 'Stellar Signed Message:\n'
const KDF_SALT_LABEL = 'stellar-mosaic/recovery/root/v1'
const SUBKEY_SALT_LABEL = 'stellar-mosaic/recovery/subkeys/v1'

export interface RecoveryStatus {
  unlocked: boolean
  syncing: boolean
  error: string | null
  account: string | null
  networkPassphrase: string | null
}

interface RecoverySession {
  id: string
  account: string
  networkPassphrase: string
  encryptionKey: CryptoKey
  backupId: string
  writeToken: string
  generation: number
}

interface RecoveryCacheDB extends DBSchema {
  sessions: { key: string; value: RecoverySession }
}

interface Snapshot {
  schema_version: 1
  account: string
  network_passphrase: string
  notes: Note[]
  created_at: number
}

export interface RecoveryFile extends WalletBackupEnvelope {
  format: 'stellar-mosaic-backup'
  backup_id: string
}

let active: RecoverySession | null = null
let accountSelection = 0
let state: RecoveryStatus = {
  unlocked: false,
  syncing: false,
  error: null,
  account: null,
  networkPassphrase: null,
}
const listeners = new Set<(s: RecoveryStatus) => void>()

let cacheDbPromise: ReturnType<typeof openDB<RecoveryCacheDB>> | null = null
function cacheDb() {
  if (!cacheDbPromise) {
    cacheDbPromise = openDB<RecoveryCacheDB>('mosaic-recovery', 1, {
      upgrade(d) {
        d.createObjectStore('sessions', { keyPath: 'id' })
      },
    })
  }
  return cacheDbPromise
}

function sessionId(account: string, networkPassphrase: string) {
  return `${account}\u0000${networkPassphrase}`
}

function publish(patch: Partial<RecoveryStatus>) {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn(state))
}

export function recoveryStatus(): RecoveryStatus {
  return state
}

export function subscribeRecovery(fn: (s: RecoveryStatus) => void): () => void {
  listeners.add(fn)
  fn(state)
  return () => listeners.delete(fn)
}

export async function selectRecoveryAccount(
  account: string | null,
  networkPassphrase: string | null,
): Promise<void> {
  const selection = ++accountSelection
  active = null
  publish({
    unlocked: false,
    syncing: false,
    error: null,
    account,
    networkPassphrase,
  })
  if (!account || !networkPassphrase) return
  const cached = await (await cacheDb()).get('sessions', sessionId(account, networkPassphrase))
  if (selection !== accountSelection) return
  if (!cached) return
  active = cached
  publish({ unlocked: true })
  try {
    await restoreFromBackend()
  } catch (e) {
    publish({ error: message(e) })
  }
}

export function isRecoveryUnlocked(account?: string): boolean {
  return !!active && (!account || active.account === account)
}

export async function unlockRecovery(account: string, networkPassphrase: string): Promise<void> {
  const selection = accountSelection
  publish({ syncing: true, error: null, account, networkPassphrase })
  try {
    const recoveryMessage = exactRecoveryMessage(account, networkPassphrase)
    const signed = await signRecoveryMessage(recoveryMessage, account, networkPassphrase)
    if (signed.signerAddress !== account) throw new Error('Freighter signed with a different account.')
    const signature = normalizeSignature(signed.signedMessage)
    await verifyFreighterSignature(account, recoveryMessage, signature)
    const material = await deriveMaterial(signature, account, networkPassphrase)
    if (
      selection !== accountSelection ||
      state.account !== account ||
      state.networkPassphrase !== networkPassphrase
    ) {
      throw new Error('The connected Stellar account changed while recovery was unlocking.')
    }
    active = {
      id: sessionId(account, networkPassphrase),
      account,
      networkPassphrase,
      encryptionKey: material.encryptionKey,
      backupId: base64Url(material.lookupKey),
      writeToken: base64Url(material.writeKey),
      generation: 0,
    }
    await (await cacheDb()).put('sessions', active)
    publish({ unlocked: true })
    await restoreFromBackend()
    // Creates an empty snapshot for a newly enrolled account and uploads any already-account-scoped
    // records. Legacy notes without wallet_address are deliberately excluded.
    await syncRecoveryNow()
  } catch (e) {
    if (selection === accountSelection) {
      active = null
      publish({ unlocked: false, error: message(e) })
    }
    throw e
  } finally {
    publish({ syncing: false })
  }
}

export async function stageRecoverableNote(note: Note): Promise<Note> {
  return (await stageRecoverableNotes([note]))[0]
}

export async function stageRecoverableNotes(notes: Note[]): Promise<Note[]> {
  const s = requireSession()
  const staged = notes.map((note): Note => ({
    ...note,
    wallet_address: s.account,
    recovery_version: 1,
    recovery_state: 'staged',
    revision: note.revision ?? 1,
  }))
  for (const note of staged) await addNote(note)
  try {
    await syncRecoveryNow()
  } catch (e) {
    for (const note of staged) await updateNote(note.id, { recovery_state: 'sync-error' })
    throw e
  }
  return staged.map((note) => ({ ...note, recovery_state: 'protected' }))
}

export async function updateNoteAndSync(id: string, patch: Partial<Note>): Promise<void> {
  await updateNote(id, patch)
  if (active) await syncRecoveryNow()
}

export async function syncRecoveryNow(): Promise<void> {
  const s = requireSession()
  publish({ syncing: true, error: null })
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await getRemote(s.backupId)
      if (remote) {
        const decoded = await decryptSnapshot(s, remote)
        await mergeRecoveryNotes(s.account, decoded.notes)
        s.generation = remote.generation
      } else {
        s.generation = 0
      }

      const notes = (await recoveryNotes(s.account)).map((n) => ({
        ...n,
        recovery_state: 'protected' as const,
      }))
      const envelope = await encryptSnapshot(s, notes)
      try {
        const result = await api.putWalletBackup(s.backupId, {
          ...envelope,
          expected_generation: s.generation,
          write_token: s.writeToken,
        })
        s.generation = result.generation
        await (await cacheDb()).put('sessions', s)
        await markRecoveryProtected(s.account)
        return
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) continue
        throw e
      }
    }
    throw new Error('Recovery backup changed repeatedly; retry after other devices finish syncing.')
  } catch (e) {
    publish({ error: message(e) })
    throw e
  } finally {
    publish({ syncing: false })
  }
}

export async function restoreFromBackend(): Promise<number> {
  const s = requireSession()
  const remote = await getRemote(s.backupId)
  if (!remote) return 0
  const snapshot = await decryptSnapshot(s, remote)
  await mergeRecoveryNotes(s.account, snapshot.notes)
  s.generation = remote.generation
  await (await cacheDb()).put('sessions', s)
  return snapshot.notes.length
}

export async function exportRecoveryFile(): Promise<RecoveryFile> {
  const s = requireSession()
  // Export is deliberately independent of backend availability: the file is the secondary copy.
  const notes = (await recoveryNotes(s.account)).map((n) => ({
    ...n,
    recovery_state: 'protected' as const,
  }))
  const envelope = await encryptSnapshot(s, notes)
  return {
    format: 'stellar-mosaic-backup',
    backup_id: s.backupId,
    ...envelope,
  }
}

export async function importRecoveryFile(file: RecoveryFile): Promise<number> {
  const s = requireSession()
  if (file.format !== 'stellar-mosaic-backup' || file.format_version !== 1) {
    throw new Error('Unsupported Mosaic recovery file.')
  }
  if (file.backup_id !== s.backupId) {
    throw new Error('Recovery file belongs to another Stellar account or network.')
  }
  const snapshot = await decryptSnapshot(s, file)
  await mergeRecoveryNotes(s.account, snapshot.notes)
  // A file must remain useful if the service backup is unavailable. A failed upload leaves the
  // restored notes local and protected by the file; recovery.error blocks future note creation.
  try {
    await syncRecoveryNow()
  } catch {
    // syncRecoveryNow already publishes the actionable error.
  }
  return snapshot.notes.length
}

export function exactRecoveryMessage(account: string, networkPassphrase: string): string {
  return [
    'Stellar Mosaic Recovery Key',
    'Version: 1',
    `Account: ${account}`,
    `Network: ${networkPassphrase}`,
    'Purpose: encrypt and restore private shielded-note secrets.',
    'WARNING: Only sign this exact message inside the trusted Stellar Mosaic application.',
  ].join('\n')
}

async function getRemote(backupId: string): Promise<WalletBackupEnvelope | null> {
  try {
    return await api.getWalletBackup(backupId)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
}

async function encryptSnapshot(s: RecoverySession, notes: Note[]): Promise<WalletBackupEnvelope> {
  const snapshot: Snapshot = {
    schema_version: 1,
    account: s.account,
    network_passphrase: s.networkPassphrase,
    notes,
    created_at: Date.now(),
  }
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: webBytes(nonce), additionalData: webBytes(aad(s)) },
    s.encryptionKey,
    new TextEncoder().encode(JSON.stringify(snapshot)),
  )
  return {
    format_version: 1,
    generation: s.generation,
    nonce_b64: base64(new Uint8Array(nonce)),
    ciphertext_b64: base64(new Uint8Array(ciphertext)),
  }
}

async function decryptSnapshot(s: RecoverySession, envelope: WalletBackupEnvelope): Promise<Snapshot> {
  if (envelope.format_version !== 1) throw new Error('Unsupported recovery-backup version.')
  let clear: ArrayBuffer
  try {
    clear = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: webBytes(fromBase64(envelope.nonce_b64)),
        additionalData: webBytes(aad(s)),
      },
      s.encryptionKey,
      webBytes(fromBase64(envelope.ciphertext_b64)),
    )
  } catch {
    throw new Error('Recovery backup authentication failed (wrong wallet or corrupted backup).')
  }
  const parsed = JSON.parse(new TextDecoder().decode(clear)) as Snapshot
  if (
    parsed.schema_version !== 1 ||
    parsed.account !== s.account ||
    parsed.network_passphrase !== s.networkPassphrase ||
    !Array.isArray(parsed.notes)
  ) {
    throw new Error('Recovery backup metadata does not match this wallet.')
  }
  return parsed
}

function aad(s: RecoverySession): Uint8Array {
  return new TextEncoder().encode(
    `stellar-mosaic-backup/v1\u0000${s.backupId}\u0000${s.account}\u0000${s.networkPassphrase}`,
  )
}

async function deriveMaterial(
  signature: Uint8Array,
  account: string,
  networkPassphrase: string,
) {
  const rootBase = await crypto.subtle.importKey('raw', webBytes(signature), 'HKDF', false, [
    'deriveBits',
  ])
  const root = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: webBytes(await sha256(KDF_SALT_LABEL)),
        info: new TextEncoder().encode(`${account}\u0000${networkPassphrase}`),
      },
      rootBase,
      256,
    ),
  )
  const subkeyBase = await crypto.subtle.importKey('raw', webBytes(root), 'HKDF', false, [
    'deriveBits',
  ])
  const derive = async (label: string) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: webBytes(await sha256(SUBKEY_SALT_LABEL)),
          info: new TextEncoder().encode(label),
        },
        subkeyBase,
        256,
      ),
    )
  const [enc, lookupKey, writeKey] = await Promise.all([
    derive('backup-encryption/v1'),
    derive('backup-id/v1'),
    derive('backup-write/v1'),
  ])
  const encryptionKey = await crypto.subtle.importKey('raw', webBytes(enc), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
  return { encryptionKey, lookupKey, writeKey }
}

async function verifyFreighterSignature(
  account: string,
  message: string,
  signature: Uint8Array,
) {
  if (signature.length !== 64) throw new Error('Freighter returned an invalid signature length.')
  const digest = await sha256(SIGNED_MESSAGE_PREFIX + message)
  if (!Keypair.fromPublicKey(account).verify(Buffer.from(digest), Buffer.from(signature))) {
    throw new Error('Freighter recovery signature could not be verified.')
  }
}

function normalizeSignature(value: string | Uint8Array | null): Uint8Array {
  if (!value) throw new Error('Freighter returned no recovery signature.')
  if (typeof value !== 'string') return Uint8Array.from(value)
  return fromBase64(value)
}

function requireSession(): RecoverySession {
  if (!active) throw new Error('Enable note recovery with the connected Stellar wallet first.')
  return active
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'))
}

function base64Url(bytes: Uint8Array): string {
  // `buffer`'s browser build does not implement Node's `base64url` encoding name.
  return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function webBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

function message(e: unknown): string {
  return errorMessage(e)
}
