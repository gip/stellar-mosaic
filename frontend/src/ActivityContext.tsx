import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityHistory, errorMessage, type ActivityEvent } from '@mosaic/sdk'
import { ApiError, api, type Desk, type Operation, type OperationRequest } from './api'
import type { AssetCatalog } from './components/activityModel'
import { executeClientAction, reconcileOperationJournals, rollbackClientAction } from './operationExecutor'
import { useRecovery } from './RecoveryContext'
import { useWallet } from './WalletContext'
import { cacheActionResult, cachedActionResult, removeCachedActionResult } from './actionCache'
import { useMosaicServer } from './MosaicServerContext'
import { browserActivityStore } from './sdk/indexedDbStore'
import { useStorageMode } from './StorageModeContext'
import { ensureBackendSession } from './auth'
import { syncTrustedActivity } from './sdk/activitySync'

interface ActivityState {
  operations: Operation[]
  activities: ActivityEvent[]
  connected: boolean
  error: string | null
  catalog: AssetCatalog
  enqueue: (request: OperationRequest) => Promise<Operation>
  cancel: (id: string) => Promise<void>
  refresh: () => Promise<void>
}

const Ctx = createContext<ActivityState | null>(null)

export function ActivityProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet()
  const mosaicServer = useMosaicServer()
  const storageMode = useStorageMode()
  const recovery = useRecovery()
  const activityStore = useMemo(() => browserActivityStore(storageMode.mode), [storageMode.mode])
  const history = useMemo(() => new ActivityHistory(activityStore), [activityStore])
  const [operations, setOperations] = useState<Operation[]>([])
  const [activities, setActivities] = useState<ActivityEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [desks, setDesks] = useState<Desk[]>([])
  const running = useRef(false)
  const activitySyncRunning = useRef(false)
  const eventCursor = useRef(0)

  // Resolve asset ids to symbols/decimals from the loaded desks, so Activity summaries read
  // "10 USDC" rather than "asset #2" — trusted-mode backend events carry no asset metadata.
  const catalog = useMemo<AssetCatalog>(() => {
    const byDesk = new Map<string, Map<number, { symbol: string; decimals: number }>>()
    for (const desk of desks) {
      const assets = new Map<number, { symbol: string; decimals: number }>()
      for (const asset of desk.assets) assets.set(asset.asset_id, { symbol: asset.symbol, decimals: asset.decimals })
      byDesk.set(desk.id, assets)
    }
    return { asset: (deskId, assetId) => (deskId ? byDesk.get(deskId)?.get(assetId) : undefined) }
  }, [desks])

  const authenticate = useCallback(async () => {
    if (!wallet.address || !wallet.networkPassphrase) throw new Error('Connect your Stellar wallet first.')
    if (!mosaicServer.trusted) throw new Error('Switch to Trusted mode to use server-backed operations.')
    await ensureBackendSession(wallet.address, wallet.networkPassphrase)
    setConnected(true)
  }, [mosaicServer.trusted, wallet.address, wallet.networkPassphrase])

  const refreshActivities = useCallback(async () => {
    if (!wallet.address) {
      setActivities([])
      return
    }
    const next = await activityStore.list()
    setActivities(next.slice(-100).toReversed())
  }, [activityStore, wallet.address])

  const refresh = useCallback(async () => {
    if (!wallet.address) return
    try {
      await authenticate()
      const next = await api.listOperations()
      if (wallet.address && recovery.unlocked) await reconcileOperationJournals(next, wallet.address)
      setOperations(next)
      await refreshActivities()
      setError(null)
    } catch (e) {
      setConnected(false)
      setError(errorMessage(e))
    }
  }, [authenticate, wallet.address, recovery.unlocked, refreshActivities])

  const enqueue = useCallback(async (request: OperationRequest) => {
    await authenticate()
    const operation = await api.createOperation(request)
    setOperations((previous) => [operation, ...previous.filter((x) => x.id !== operation.id)])
    return operation
  }, [authenticate])

  const cancel = useCallback(async (id: string) => {
    const operation = await api.cancelOperation(id)
    setOperations((previous) => previous.map((x) => x.id === id ? operation : x))
  }, [])

  // Keep the asset catalog loaded for the active mode. Best-effort: summaries fall back to asset ids
  // if desks fail to load. Refreshed on wallet/mode change (desk asset sets are immutable post-deploy).
  useEffect(() => {
    let alive = true
    const load = async () => {
      if (!wallet.address) {
        if (alive) setDesks([])
        return
      }
      try {
        const next = await api.listDesks(storageMode.mode)
        if (alive) setDesks(next)
      } catch {
        /* Activity labels degrade to asset ids; not fatal. */
      }
    }
    void load()
    return () => { alive = false }
  }, [storageMode.mode, wallet.address])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      // Logged out: show nothing, even though the browser-local store still holds history.
      if (!wallet.address) {
        if (alive) setActivities([])
        return
      }
      try {
        const next = await activityStore.list()
        if (alive) setActivities(next.slice(-100).toReversed())
      } catch {
        /* Activity is best-effort UI state; writes remain durable. */
      }
    }
    void tick()
    const interval = window.setInterval(() => void tick(), 1000)
    return () => {
      alive = false
      window.clearInterval(interval)
    }
  }, [activityStore, wallet.address])

  useEffect(() => {
    let active = true
    const selectWallet = async () => {
      await Promise.resolve()
      if (!active) return
      setOperations([]); setActivities([]); setConnected(false); setError(null); eventCursor.current = 0
      await refreshActivities().catch(() => {})
      if (wallet.address && wallet.networkPassphrase && mosaicServer.trusted) await refresh()
    }
    void selectWallet()
    return () => { active = false }
  }, [mosaicServer.trusted, storageMode.mode, wallet.address, wallet.networkPassphrase, refresh, refreshActivities])

  // Durable event replay over MCP. A periodic poll replaces the old backend SSE stream.
  useEffect(() => {
    if (!connected) return
    let alive = true
    const tick = async () => {
      try {
        const events = await api.operationEventsSince(eventCursor.current)
        if (!alive || events.length === 0) return
        eventCursor.current = Math.max(eventCursor.current, ...events.map((event) => event.cursor))
        await history.ingestOperationEvents(events, {
          wallet_address: wallet.address ?? undefined,
          network: wallet.networkPassphrase ?? undefined,
        })
        await refreshActivities()
        await refresh()
      } catch {
        if (alive) {
          setConnected(false)
          setTimeout(() => void refresh(), 2000)
        }
      }
    }
    void tick()
    const interval = window.setInterval(() => void tick(), 1000)
    return () => {
      alive = false
      window.clearInterval(interval)
    }
  }, [connected, history, refresh, refreshActivities, wallet.address, wallet.networkPassphrase])

  useEffect(() => {
    if (!connected || !storageMode.trusted || !wallet.address || !wallet.networkPassphrase) return
    let alive = true
    const tick = async () => {
      if (!alive || activitySyncRunning.current) return
      activitySyncRunning.current = true
      try {
        const result = await syncTrustedActivity({
          address: wallet.address!,
          network: wallet.networkPassphrase!,
          store: activityStore,
          api,
        })
        if (alive && result.pulled > 0) await refreshActivities()
      } catch {
        /* Activity mirroring is best-effort; local IndexedDB remains the UI source of truth. */
      } finally {
        activitySyncRunning.current = false
      }
    }
    void tick()
    const interval = window.setInterval(() => void tick(), 1500)
    return () => {
      alive = false
      window.clearInterval(interval)
    }
  }, [activityStore, connected, refreshActivities, storageMode.trusted, wallet.address, wallet.networkPassphrase])

  // Any tab may poll, but the backend lease lets only one execute the private step.
  useEffect(() => {
    if (!connected || !recovery.unlocked || recovery.error) return
    let alive = true
    const tick = async () => {
      if (!alive || running.current) return
      running.current = true
      try {
        const { action } = await api.claimClientAction()
        if (!action) return
        let heartbeat: number | undefined
        try {
          heartbeat = window.setInterval(() => {
            void api.heartbeatClientAction(action.id, action.lease_token)
          }, 30_000)
          const result = (await cachedActionResult(action.id)) ?? await executeClientAction(action)
          await cacheActionResult(action.id, result)
          await api.completeClientAction(action.id, action.lease_token, result)
          await removeCachedActionResult(action.id)
        } catch (e) {
          const message = errorMessage(e)
          const retryable = e instanceof ApiError && (e.status === 502 || e.status === 503 || e.status === 504)
          console.error(`[mosaic] client action ${action.payload.kind} (${action.id}) failed: ${message}`, e)
          const failed = await api.failClientAction(action.id, action.lease_token, message, retryable).catch(() => null)
          if (failed?.status === 'succeeded' && wallet.address) {
            await reconcileOperationJournals([failed], wallet.address).catch(() => {})
          } else if (!retryable) {
            await rollbackClientAction(action).catch(() => {})
          }
        } finally {
          if (heartbeat) window.clearInterval(heartbeat)
          await refresh()
        }
      } finally {
        running.current = false
      }
    }
    void tick()
    const handle = window.setInterval(() => void tick(), 2000)
    return () => { alive = false; window.clearInterval(handle) }
  }, [connected, recovery.unlocked, recovery.error, refresh, wallet.address])

  return <Ctx.Provider value={{ operations, activities, connected, error, catalog, enqueue, cancel, refresh }}>{children}</Ctx.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useActivity(): ActivityState {
  const value = useContext(Ctx)
  if (!value) throw new Error('useActivity outside ActivityProvider')
  return value
}
