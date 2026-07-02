import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

interface ActionCacheDb extends DBSchema {
  results: { key: string; value: { id: string; result: Record<string, unknown>; completedAt: number } }
}

let dbPromise: Promise<IDBPDatabase<ActionCacheDb>> | undefined
function database(): Promise<IDBPDatabase<ActionCacheDb>> {
  dbPromise ??= openDB<ActionCacheDb>('mosaic-operation-actions', 1, {
    upgrade(db) { db.createObjectStore('results', { keyPath: 'id' }) },
    // Close on a blocked versionchange (e.g. resetBrowserData()'s deleteDatabase) so it can't hang
    // 'blocked' and deadlock later opens; reopen lazily on next use.
    blocking() {
      void dbPromise?.then((d) => d.close())
      dbPromise = undefined
    },
    terminated() {
      dbPromise = undefined
    },
  })
  return dbPromise
}

export async function cachedActionResult(id: string) {
  return (await (await database()).get('results', id))?.result ?? null
}

export async function cacheActionResult(id: string, result: Record<string, unknown>) {
  await (await database()).put('results', { id, result, completedAt: Date.now() })
}

export async function removeCachedActionResult(id: string) {
  await (await database()).delete('results', id)
}
