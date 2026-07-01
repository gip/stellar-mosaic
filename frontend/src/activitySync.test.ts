import test from 'node:test'
import assert from 'node:assert/strict'
import type { ActivityEvent, ActivityQuery, ActivityStore } from '@mosaic/sdk'
import { matchesActivityQuery, normalizeActivityEvent } from '@mosaic/sdk'
import { isRemoteActivity, markRemoteActivity, syncTrustedActivity } from './sdk/activitySync.ts'

class MemoryActivityStore implements ActivityStore {
  events: ActivityEvent[] = []
  nextCursor = 1

  async record(event: ActivityEvent): Promise<ActivityEvent> {
    const stored = normalizeActivityEvent(event)
    const existing = this.events.find((item) =>
      (stored.idempotency_key && item.idempotency_key === stored.idempotency_key) || item.id === stored.id,
    )
    if (existing) return existing
    const withCursor = { ...stored, cursor: this.nextCursor++ }
    this.events.push(withCursor)
    return withCursor
  }

  async list(query: ActivityQuery = {}): Promise<ActivityEvent[]> {
    return this.events.filter((event) => matchesActivityQuery(event, query))
  }

  async since(cursor: number, query: ActivityQuery = {}): Promise<ActivityEvent[]> {
    return (await this.list(query)).filter((event) => (event.cursor ?? 0) > cursor)
  }
}

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

test('trusted activity sync pushes local client events and pulls remote events without rewriting identity', async () => {
  const store = new MemoryActivityStore()
  const storage = new MemoryStorage()
  await store.record({ id: 'local-1', kind: 'transaction', wallet_address: 'GABC', network: 'testnet' })
  await store.record({ id: 'backend-1', kind: 'backend_operation', wallet_address: 'GABC', network: 'testnet' })
  await store.record(markRemoteActivity({ id: 'remote-local', kind: 'error', wallet_address: 'GABC', network: 'testnet', cursor: 10 }))

  const pushed: ActivityEvent[][] = []
  const result = await syncTrustedActivity({
    address: 'GABC',
    network: 'testnet',
    store,
    storage,
    api: {
      async recordActivity(events) {
        pushed.push(events)
        return events.map((event, index) => ({ ...event, cursor: index + 1 }))
      },
      async activitySince(cursor) {
        assert.equal(cursor, 0)
        return [{ id: 'remote-1', idempotency_key: 'remote-idem-1', kind: 'fill', cursor: 7, wallet_address: 'GABC', network: 'testnet' }]
      },
    },
  })

  assert.equal(result.pushed, 1)
  assert.equal(result.pulled, 1)
  assert.deepEqual(pushed[0].map((event) => event.id), ['local-1'])
  const pulled = store.events.find((event) => event.id === 'remote-1')
  assert.ok(pulled)
  assert.equal(pulled.idempotency_key, 'remote-idem-1')
  assert.equal(isRemoteActivity(pulled), true)
})
