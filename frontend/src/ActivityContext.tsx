import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError, api, type Operation, type OperationRequest } from './api'
import { ensureBackendSession } from './auth'
import { executeClientAction, reconcileOperationJournals, rollbackClientAction } from './operationExecutor'
import { useRecovery } from './RecoveryContext'
import { useWallet } from './WalletContext'
import { cacheActionResult, cachedActionResult, removeCachedActionResult } from './actionCache'

interface ActivityState {
  operations: Operation[]
  connected: boolean
  error: string | null
  enqueue: (request: OperationRequest) => Promise<Operation>
  cancel: (id: string) => Promise<void>
  refresh: () => Promise<void>
}

const Ctx = createContext<ActivityState | null>(null)

export function ActivityProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet()
  const recovery = useRecovery()
  const [operations, setOperations] = useState<Operation[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)

  const authenticate = useCallback(async () => {
    if (!wallet.address || !wallet.networkPassphrase) throw new Error('Connect your Stellar wallet first.')
    await ensureBackendSession(wallet.address, wallet.networkPassphrase)
    setConnected(true)
  }, [wallet.address, wallet.networkPassphrase])

  const refresh = useCallback(async () => {
    if (!wallet.address) return
    try {
      await authenticate()
      const next = await api.listOperations()
      if (wallet.address && recovery.unlocked) await reconcileOperationJournals(next, wallet.address)
      setOperations(next)
      setError(null)
    } catch (e) {
      setConnected(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [authenticate, wallet.address, recovery.unlocked])

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

  useEffect(() => {
    let active = true
    const selectWallet = async () => {
      await Promise.resolve()
      if (!active) return
      setOperations([]); setConnected(false); setError(null)
      if (wallet.address && wallet.networkPassphrase) await refresh()
    }
    void selectWallet()
    return () => { active = false }
  }, [wallet.address, wallet.networkPassphrase, refresh])

  // Durable event stream. REST refresh is the reconnect/history fallback.
  useEffect(() => {
    if (!connected) return
    const source = new EventSource('/api/operations/events', { withCredentials: true })
    source.addEventListener('operation', () => void refresh())
    source.onerror = () => {
      source.close()
      setConnected(false)
      setTimeout(() => void refresh(), 2000)
    }
    return () => source.close()
  }, [connected, refresh])

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
          const message = e instanceof Error ? e.message : String(e)
          const retryable = e instanceof ApiError && (e.status === 502 || e.status === 503 || e.status === 504)
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

  return <Ctx.Provider value={{ operations, connected, error, enqueue, cancel, refresh }}>{children}</Ctx.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useActivity(): ActivityState {
  const value = useContext(Ctx)
  if (!value) throw new Error('useActivity outside ActivityProvider')
  return value
}
