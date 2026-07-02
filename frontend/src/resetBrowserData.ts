// Full local-state wipe for the /settings "danger zone" button. When a browser profile's cached
// state (IndexedDB event-replay cache, localStorage flags, session cookies) has drifted from
// on-chain reality, the fastest fix during testing is to start over rather than track down which
// cache entry is stale — this clears every storage surface the app touches in this origin.
//
// This button's whole point is to be a reliable escape hatch, so every step is individually bounded:
// a wedged browser API (or, for the caller's own network cleanup, a hung fetch) must never leave the
// user stuck on "Resetting…" forever. Each step best-effort logs and moves on instead of failing the
// whole reset.
const STEP_TIMEOUT_MS = 2000
// The IndexedDB wipe gets a longer bound than the other steps: we now wait for each deleteDatabase
// to *actually complete* (see deleteDatabase below) rather than declaring victory the moment it's
// blocked, and closing the app's open connections + finishing several deletes can take longer than
// the 2s the trivial steps use.
const INDEXEDDB_TIMEOUT_MS = 8000

export async function resetBrowserData(): Promise<void> {
  const errors: unknown[] = []
  const run = async (label: string, fn: () => Promise<void>, timeoutMs = STEP_TIMEOUT_MS) => {
    try {
      await withTimeout(fn(), timeoutMs, label)
    } catch (e) {
      errors.push(e)
    }
  }

  await run('indexedDB', async () => {
    if (typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases()
      await Promise.all(dbs.map((db) => db.name).filter((name): name is string => !!name).map(deleteDatabase))
    } else {
      // Safari/older browsers have no enumeration API; delete the databases this app is known to
      // create directly (see indexedDbStore.ts's `indexedDbName`).
      await Promise.all(['mosaic-trusted', 'mosaic-trustless'].map(deleteDatabase))
    }
  }, INDEXEDDB_TIMEOUT_MS)

  await run('caches', async () => {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
    }
  })

  await run('serviceWorker', async () => {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((registration) => registration.unregister()))
    }
  })

  await run('localStorage', () => {
    localStorage.clear()
    return Promise.resolve()
  })

  await run('sessionStorage', () => {
    sessionStorage.clear()
    return Promise.resolve()
  })

  await run('cookies', () => {
    deleteAllCookies()
    return Promise.resolve()
  })

  if (errors.length > 0) console.error('[mosaic] resetBrowserData: some storage failed to clear in time', errors)
}

/** Race `promise` against a timeout so a wedged browser API (or caller-supplied cleanup, e.g. a
 * hung MCP logout request — `fetch` has no default timeout) can't block the reset indefinitely.
 * The original operation keeps running in the background; we just stop waiting on it. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

// A `document.cookie = "name="` write only deletes the cookie if the expiry/path/domain in the
// write exactly matches how it was set — this app sets none today, but the button promises "all
// cookies", so cover the realistic variants (default path, root path, and each parent domain of
// the current host) rather than the single case that would work for a cookie this app itself set.
function deleteAllCookies(): void {
  const names = document.cookie
    .split(';')
    .map((entry) => entry.split('=')[0]?.trim())
    .filter((name): name is string => !!name)
  if (names.length === 0) return

  const expired = 'expires=Thu, 01 Jan 1970 00:00:00 GMT'
  const hostParts = location.hostname.split('.')
  const domains = ['', location.hostname, ...hostParts.map((_, i) => `.${hostParts.slice(i).join('.')}`)]
  const paths = ['/', location.pathname]

  for (const name of names) {
    for (const path of paths) {
      for (const domain of domains) {
        document.cookie = `${name}=; ${expired}; path=${path}${domain ? `; domain=${domain}` : ''}`
      }
    }
  }
}

// Delete one database and wait for the deletion to *actually complete*. The earlier version
// resolved on `onblocked` too — but `blocked` means the delete is only queued, still pending behind
// an open connection. Walking away then (the app reopens the DB on the next render and the page
// reloads) races an open against a half-finished delete, which wedges Chrome's IndexedDB backing
// store for the whole origin: afterwards every openDB() hangs silently — no success, no error, not
// even a `blocked` event — which is exactly the "Loading… forever" the desk list showed.
//
// The app's own openDB() sites register `blocking` handlers that close their connection when a
// versionchange (this delete) needs it, so the delete unblocks and reaches `onsuccess` on its own.
// We wait for that. `onblocked` only logs; the caller's step timeout is the backstop if some
// connection we don't control (e.g. another tab on old code) never closes.
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => console.warn(`[mosaic] resetBrowserData: deleteDatabase(${name}) blocked, waiting for open connections to close`)
  })
}
