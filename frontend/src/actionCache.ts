import { openDB, type DBSchema } from 'idb'

interface ActionCacheDb extends DBSchema {
  results: { key: string; value: { id: string; result: Record<string, unknown>; completedAt: number } }
}

const database = openDB<ActionCacheDb>('mosaic-operation-actions', 1, {
  upgrade(db) { db.createObjectStore('results', { keyPath: 'id' }) },
})

export async function cachedActionResult(id: string) {
  return (await (await database).get('results', id))?.result ?? null
}

export async function cacheActionResult(id: string, result: Record<string, unknown>) {
  await (await database).put('results', { id, result, completedAt: Date.now() })
}

export async function removeCachedActionResult(id: string) {
  await (await database).delete('results', id)
}
