import type { ActivityEvent, ActivityStore } from '@mosaic/sdk'

export interface ActivitySyncApi {
  recordActivity(events: ActivityEvent[]): Promise<ActivityEvent[]>
  activitySince(cursor: number): Promise<ActivityEvent[]>
}

interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ActivitySyncOptions {
  address: string
  network: string
  store: ActivityStore
  api: ActivitySyncApi
  storage?: KeyValueStore
  batchSize?: number
}

const REMOTE_SOURCE = 'mcp'
const PUSH_PREFIX = 'mosaic.activityPush'
const PULL_PREFIX = 'mosaic.activityPull'

function storage(): KeyValueStore | undefined {
  if (typeof localStorage === 'undefined') return undefined
  return localStorage
}

function scope(prefix: string, address: string, network: string): string {
  return `${prefix}.${address}.${network}`
}

function readCursor(source: KeyValueStore | undefined, key: string): number {
  if (!source) return 0
  const raw = source.getItem(key)
  if (!raw) return 0
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function writeCursor(source: KeyValueStore | undefined, key: string, cursor: number): void {
  if (!source) return
  source.setItem(key, String(Math.max(0, Math.floor(cursor))))
}

export function isRemoteActivity(event: ActivityEvent): boolean {
  return event.metadata?.mosaic_remote_source === REMOTE_SOURCE
}

export function markRemoteActivity(event: ActivityEvent): ActivityEvent {
  return {
    ...event,
    metadata: {
      ...event.metadata,
      mosaic_remote_source: REMOTE_SOURCE,
      mosaic_remote_cursor: event.cursor,
    },
  }
}

function belongsToScope(event: ActivityEvent, address: string, network: string): boolean {
  if (event.wallet_address && event.wallet_address !== address) return false
  if (event.network && event.network !== network) return false
  return true
}

function maxCursor(events: ActivityEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.cursor ?? 0), 0)
}

export async function syncTrustedActivity({
  address,
  network,
  store,
  api,
  storage: storageOverride,
  batchSize = 50,
}: ActivitySyncOptions): Promise<{ pushed: number; pulled: number }> {
  const source = storageOverride ?? storage()
  const pushKey = scope(PUSH_PREFIX, address, network)
  const pullKey = scope(PULL_PREFIX, address, network)
  let pushed = 0
  let pulled = 0

  const lastPushed = readCursor(source, pushKey)
  const pushCandidates = (await store.since(lastPushed))
    .filter((event) => event.kind !== 'backend_operation')
    .filter((event) => !isRemoteActivity(event))
    .filter((event) => belongsToScope(event, address, network))
    .sort((a, b) => (a.cursor ?? 0) - (b.cursor ?? 0))
    .slice(0, batchSize)
  if (pushCandidates.length > 0) {
    await api.recordActivity(pushCandidates)
    writeCursor(source, pushKey, maxCursor(pushCandidates))
    pushed = pushCandidates.length
  }

  const lastPulled = readCursor(source, pullKey)
  const remote = await api.activitySince(lastPulled)
  if (remote.length > 0) {
    for (const event of remote) await store.record(markRemoteActivity(event))
    writeCursor(source, pullKey, maxCursor(remote))
    pulled = remote.length
  }

  return { pushed, pulled }
}
