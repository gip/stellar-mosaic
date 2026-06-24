import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { BASE_FEE, Contract, Networks, TransactionBuilder, rpc, scValToNative } from '@stellar/stellar-sdk'
import type { Desk } from './api'
import { Buffer } from 'buffer'

export const SOROBAN_RPC_URL =
  import.meta.env.VITE_SOROBAN_RPC ?? 'https://soroban-testnet.stellar.org'
export const BOOK_SCHEMA_VERSION = 1

export interface IndexedOrder {
  id: string
  scope: string
  book: string
  pair_id: number
  side: number
  order_id: string
  amount_in: string
  min_out: string
  remaining_in: string
  output_owner_tag: string
  cancel_owner_tag: string
  order_leaf: string
  expiry: string
  partial_allowed: boolean
  priority_sequence: string
}

export interface IndexedAsset {
  id: string
  scope: string
  asset_id: number
  token: string
}

export interface IndexedPair {
  id: string
  scope: string
  pair_id: number
  base_asset: number
  quote_asset: number
}

interface BookMeta {
  scope: string
  initialized: boolean
  schema_version?: number
  cursor?: string
  last_sequence: string
  latest_ledger: number
  target_sequence: string
  fatal_error?: string
  vk_hashes?: string[]
  release_verified?: boolean
}

interface ProcessedEvent {
  id: string
  scope: string
}

interface BookDB extends DBSchema {
  meta: { key: string; value: BookMeta }
  orders: {
    key: string
    value: IndexedOrder
    indexes: { 'by-scope': string; 'by-book': string }
  }
  assets: {
    key: string
    value: IndexedAsset
    indexes: { 'by-scope': string }
  }
  pairs: {
    key: string
    value: IndexedPair
    indexes: { 'by-scope': string }
  }
  processed: {
    key: string
    value: ProcessedEvent
    indexes: { 'by-scope': string }
  }
}

let dbPromise: Promise<IDBPDatabase<BookDB>> | undefined
function database(): Promise<IDBPDatabase<BookDB>> {
  dbPromise ??= openDB<BookDB>('mosaic-book', 1, {
    upgrade(db) {
      db.createObjectStore('meta', { keyPath: 'scope' })
      const orders = db.createObjectStore('orders', { keyPath: 'id' })
      orders.createIndex('by-scope', 'scope')
      orders.createIndex('by-book', 'book')
      db.createObjectStore('assets', { keyPath: 'id' }).createIndex('by-scope', 'scope')
      db.createObjectStore('pairs', { keyPath: 'id' }).createIndex('by-scope', 'scope')
      db.createObjectStore('processed', { keyPath: 'id' }).createIndex('by-scope', 'scope')
    },
  })
  return dbPromise
}

function scopeOf(networkPassphrase: string, contractId: string): string {
  return `${networkPassphrase}\u0000${contractId}`
}

function bookKey(scope: string, pair: number, side: number): string {
  return `${scope}\u0000${pair}\u0000${side}`
}

function orderKey(scope: string, pair: number, side: number, orderId: string): string {
  return `${bookKey(scope, pair, side)}\u0000${orderId}`
}

function hex(value: unknown): string {
  if (!(value instanceof Uint8Array)) throw new Error('expected bytes in contract event')
  return `0x${Array.from(value, (v) => v.toString(16).padStart(2, '0')).join('')}`
}

function number(value: unknown, label: string): number {
  const n = typeof value === 'bigint' ? Number(value) : value
  if (!Number.isSafeInteger(n)) throw new Error(`invalid ${label}`)
  return n as number
}

function bigint(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new Error(`invalid ${label}`)
  return value
}

function fields(value: unknown, expected: number): unknown[] {
  if (!Array.isArray(value) || value.length !== expected) {
    throw new Error(`book event has ${Array.isArray(value) ? value.length : 'non-vector'} fields; expected ${expected}`)
  }
  return value
}

function topic(event: rpc.Api.EventResponse): string {
  if (event.topic.length !== 1) throw new Error(`unexpected topic count for event ${event.id}`)
  const value = scValToNative(event.topic[0])
  if (typeof value !== 'string') throw new Error(`non-symbol topic for event ${event.id}`)
  return value
}

function initialMeta(scope: string): BookMeta {
  return {
    scope,
    initialized: false,
    last_sequence: '0',
    latest_ledger: 0,
    target_sequence: '0',
  }
}

interface ReleaseManifest {
  schema_version: number
  wasm_hash: string
  vk_hashes: { lift: string; unshield: string; cancel: string; join: string }
}

let releaseManifest: Promise<ReleaseManifest> | undefined
class BookIntegrityError extends Error {}
function manifest(): Promise<ReleaseManifest> {
  releaseManifest ??= fetch('/protocol-release.json')
    .then(async (response) => {
      if (!response.ok) throw new Error(`failed to load protocol release manifest: ${response.status}`)
      return (await response.json()) as ReleaseManifest
    })
    .catch((error) => {
      releaseManifest = undefined
      throw error
    })
  return releaseManifest
}

function normalizedHash(value: string): string {
  return value.replace(/^0x/i, '').toLowerCase()
}

async function verifyRelease(
  server: rpc.Server,
  contractId: string,
  meta: BookMeta,
): Promise<void> {
  const release = await manifest()
  if (meta.schema_version !== release.schema_version) throw new BookIntegrityError('contract schema does not match release manifest')
  const expectedVks = [
    release.vk_hashes.lift,
    release.vk_hashes.unshield,
    release.vk_hashes.cancel,
    release.vk_hashes.join,
  ].map(normalizedHash)
  if (!meta.vk_hashes || meta.vk_hashes.map(normalizedHash).join() !== expectedVks.join()) {
    throw new BookIntegrityError('contract verification-key hashes do not match release manifest')
  }
  const entries = await server.getLedgerEntries(new Contract(contractId).getFootprint())
  const data = entries.entries[0]?.val.contractData().val()
  if (!data || data.switch().name !== 'scvContractInstance') throw new BookIntegrityError('contract instance ledger entry is missing')
  const executable = data.instance().executable()
  if (executable.switch().name !== 'contractExecutableWasm') throw new BookIntegrityError('desk is not a WASM contract')
  const wasmHash = Buffer.from(executable.wasmHash()).toString('hex')
  if (normalizedHash(wasmHash) !== normalizedHash(release.wasm_hash)) {
    throw new BookIntegrityError('contract WASM hash does not match release manifest')
  }
}

/** Apply one RPC page and its cursor atomically. Exported for deterministic reducer tests. */
export async function applyBookEventPage(
  scope: string,
  events: rpc.Api.EventResponse[],
  cursor: string,
  latestLedger: number,
): Promise<void> {
  const db = await database()
  const tx = db.transaction(['meta', 'orders', 'assets', 'pairs', 'processed'], 'readwrite')
  try {
  const meta = (await tx.objectStore('meta').get(scope)) ?? initialMeta(scope)
  let sequence = BigInt(meta.last_sequence)

  for (const event of events) {
    const processedId = `${scope}\u0000${event.id}`
    if (await tx.objectStore('processed').get(processedId)) continue
    const name = topic(event)
    const native = scValToNative(event.value)

    if (name === 'bookinit') {
      const f = fields(native, 5)
      const schema = number(f[0], 'schema version')
      if (schema !== BOOK_SCHEMA_VERSION) throw new Error(`unsupported book event schema ${schema}`)
      const hashes = f.slice(1).map(hex)
      if (meta.initialized && (meta.schema_version !== schema || meta.vk_hashes?.join() !== hashes.join())) {
        throw new Error('conflicting bookinit event')
      }
      meta.initialized = true
      meta.schema_version = schema
      meta.vk_hashes = hashes
    } else if (name === 'assetreg') {
      if (!meta.initialized) throw new Error('assetreg before bookinit')
      const f = fields(native, 2)
      const assetId = number(f[0], 'asset id')
      const token = String(f[1])
      const id = `${scope}\u0000${assetId}`
      const existing = await tx.objectStore('assets').get(id)
      if (existing && existing.token !== token) throw new Error(`conflicting asset ${assetId}`)
      await tx.objectStore('assets').put({ id, scope, asset_id: assetId, token })
    } else if (name === 'pairreg') {
      if (!meta.initialized) throw new Error('pairreg before bookinit')
      const f = fields(native, 3)
      const pairId = number(f[0], 'pair id')
      const pair: IndexedPair = {
        id: `${scope}\u0000${pairId}`,
        scope,
        pair_id: pairId,
        base_asset: number(f[1], 'base asset'),
        quote_asset: number(f[2], 'quote asset'),
      }
      const existing = await tx.objectStore('pairs').get(pair.id)
      if (existing && (existing.base_asset !== pair.base_asset || existing.quote_asset !== pair.quote_asset)) {
        throw new Error(`conflicting pair ${pairId}`)
      }
      await tx.objectStore('pairs').put(pair)
    } else if (name === 'ordupsert') {
      if (!meta.initialized) throw new Error('ordupsert before bookinit')
      const f = fields(native, 12)
      const next = bigint(f[0], 'book sequence')
      if (next !== sequence + 1n) throw new Error(`book sequence gap: expected ${sequence + 1n}, got ${next}`)
      const pair = number(f[1], 'pair id')
      const side = number(f[2], 'side')
      if (side !== 0 && side !== 1) throw new Error(`invalid book side ${side}`)
      const orderId = hex(f[3])
      const id = orderKey(scope, pair, side, orderId)
      const existing = await tx.objectStore('orders').get(id)
      const order: IndexedOrder = {
        id,
        scope,
        book: bookKey(scope, pair, side),
        pair_id: pair,
        side,
        order_id: orderId,
        amount_in: bigint(f[4], 'amount_in').toString(),
        min_out: bigint(f[5], 'min_out').toString(),
        remaining_in: bigint(f[6], 'remaining_in').toString(),
        output_owner_tag: hex(f[7]),
        cancel_owner_tag: hex(f[8]),
        order_leaf: hex(f[9]),
        expiry: bigint(f[10], 'expiry').toString(),
        partial_allowed: Boolean(f[11]),
        priority_sequence: existing?.priority_sequence ?? next.toString(),
      }
      await tx.objectStore('orders').put(order)
      sequence = next
    } else if (name === 'ordremove') {
      if (!meta.initialized) throw new Error('ordremove before bookinit')
      const f = fields(native, 5)
      const next = bigint(f[0], 'book sequence')
      if (next !== sequence + 1n) throw new Error(`book sequence gap: expected ${sequence + 1n}, got ${next}`)
      const pair = number(f[1], 'pair id')
      const side = number(f[2], 'side')
      if (side !== 0 && side !== 1) throw new Error(`invalid book side ${side}`)
      const orderId = hex(f[3])
      const reason = number(f[4], 'removal reason')
      if (reason < 0 || reason > 2) throw new Error(`invalid removal reason ${reason}`)
      const id = orderKey(scope, pair, side, orderId)
      if (!(await tx.objectStore('orders').get(id))) throw new Error(`removal of unknown order ${orderId}`)
      await tx.objectStore('orders').delete(id)
      sequence = next
    } else {
      continue
    }

    await tx.objectStore('processed').put({ id: processedId, scope })
  }

  meta.cursor = cursor
  meta.last_sequence = sequence.toString()
  meta.latest_ledger = latestLedger
  delete meta.fatal_error
  await tx.objectStore('meta').put(meta)
  await tx.done
  } catch (error) {
    try {
      tx.abort()
    } catch {
      // The browser may already have aborted the transaction after a failed request.
    }
    throw error
  }
}

async function setFatal(scope: string, message: string): Promise<void> {
  const db = await database()
  const meta = (await db.get('meta', scope)) ?? initialMeta(scope)
  meta.fatal_error = message
  await db.put('meta', meta)
}

export interface BookIndexSnapshot {
  status: 'syncing' | 'synced' | 'error'
  error?: string
  lastLedger: number
  lastSequence: string
  targetSequence: string
  orders: IndexedOrder[]
  assets: IndexedAsset[]
  pairs: IndexedPair[]
}

async function snapshot(scope: string): Promise<BookIndexSnapshot> {
  const db = await database()
  const meta = (await db.get('meta', scope)) ?? initialMeta(scope)
  const orders = await db.getAllFromIndex('orders', 'by-scope', IDBKeyRange.only(scope))
  const assets = await db.getAllFromIndex('assets', 'by-scope', IDBKeyRange.only(scope))
  const pairs = await db.getAllFromIndex('pairs', 'by-scope', IDBKeyRange.only(scope))
  return {
    status: meta.fatal_error
      ? 'error'
      : meta.initialized && meta.release_verified && BigInt(meta.last_sequence) === BigInt(meta.target_sequence)
        ? 'synced'
        : 'syncing',
    error: meta.fatal_error,
    lastLedger: meta.latest_ledger,
    lastSequence: meta.last_sequence,
    targetSequence: meta.target_sequence,
    orders,
    assets,
    pairs,
  }
}

async function readBookSequence(
  server: rpc.Server,
  contractId: string,
  sourceAccount: string,
  networkPassphrase: string,
): Promise<bigint> {
  const account = await server.getAccount(sourceAccount)
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(new Contract(contractId).call('book_sequence'))
    .setTimeout(30)
    .build()
  const simulation = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(simulation) || !simulation.result) {
    throw new Error(`book_sequence simulation failed${rpc.Api.isSimulationError(simulation) ? `: ${simulation.error}` : ''}`)
  }
  return bigint(scValToNative(simulation.result.retval), 'book_sequence')
}

export async function syncBookIndex(
  contractId: string,
  sourceAccount: string,
  networkPassphrase: string = Networks.TESTNET,
  eventStartLedger?: number | null,
): Promise<BookIndexSnapshot> {
  const scope = scopeOf(networkPassphrase, contractId)
  const server = new rpc.Server(SOROBAN_RPC_URL)
  const transient = async (error: unknown) => ({
    ...(await snapshot(scope)),
    status: 'syncing' as const,
    error: error instanceof Error ? error.message : String(error),
  })
  const db = await database()
  const meta = (await db.get('meta', scope)) ?? initialMeta(scope)
  if (meta.fatal_error) return snapshot(scope)
  let response: rpc.Api.GetEventsResponse
  try {
    if (!meta.cursor && !eventStartLedger) {
      throw new Error('desk event start ledger is unavailable; re-import the contract')
    }
    response = meta.cursor
      ? await server.getEvents({ filters: [{ type: 'contract', contractIds: [contractId] }], cursor: meta.cursor, limit: 1000 })
      : await server.getEvents({ filters: [{ type: 'contract', contractIds: [contractId] }], startLedger: eventStartLedger!, limit: 1000 })
  } catch (error) {
    return transient(error)
  }
  try {
    await applyBookEventPage(scope, response.events, response.cursor, response.latestLedger)
  } catch (error) {
    await setFatal(scope, error instanceof Error ? error.message : String(error))
    return snapshot(scope)
  }
  let target: bigint
  try {
    target = await readBookSequence(server, contractId, sourceAccount, networkPassphrase)
  } catch (error) {
    return transient(error)
  }
  const updated = (await db.get('meta', scope)) ?? initialMeta(scope)
  updated.target_sequence = target.toString()
  if (!updated.initialized && response.latestLedger <= updated.latest_ledger) {
    await setFatal(scope, 'bookinit event not found in archival history')
    return snapshot(scope)
  }
  try {
    await verifyRelease(server, contractId, updated)
    updated.release_verified = true
    await db.put('meta', updated)
  } catch (error) {
    if (error instanceof BookIntegrityError) {
      await setFatal(scope, error.message)
      return snapshot(scope)
    }
    return transient(error)
  }
  return snapshot(scope)
}

export function ordersFor(snapshot: BookIndexSnapshot, pairId: number, side: number): IndexedOrder[] {
  const orders = snapshot.orders.filter((o) => o.pair_id === pairId && o.side === side)
  return orders.sort((a, b) => compareOrders(a, b, side))
}

export function compareOrders(a: IndexedOrder, b: IndexedOrder, side: number): number {
  const ai = BigInt(a.amount_in)
  const ao = BigInt(a.min_out)
  const bi = BigInt(b.amount_in)
  const bo = BigInt(b.min_out)
  const left = side === 1 ? ao * bi : ai * bo
  const right = side === 1 ? bo * ai : bi * ao
  if (left !== right) return side === 1 ? (left < right ? -1 : 1) : left > right ? -1 : 1
  const ap = BigInt(a.priority_sequence)
  const bp = BigInt(b.priority_sequence)
  return ap < bp ? -1 : ap > bp ? 1 : 0
}

export async function clearBookIndex(desk: Desk, networkPassphrase: string = Networks.TESTNET): Promise<void> {
  const scope = scopeOf(networkPassphrase, desk.contract_id)
  const db = await database()
  const tx = db.transaction(['meta', 'orders', 'assets', 'pairs', 'processed'], 'readwrite')
  await tx.objectStore('meta').delete(scope)
  for (const store of ['orders', 'assets', 'pairs', 'processed'] as const) {
    let cursor = await tx.objectStore(store).index('by-scope').openCursor(IDBKeyRange.only(scope))
    while (cursor) {
      await cursor.delete()
      cursor = await cursor.continue()
    }
  }
  await tx.done
}
