import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { ensureBackendSession } from './auth'
import { useWallet } from './WalletContext'
import { api, resetApiCaches } from './api'
import { setRecoveryBackendEnabled, setRecoveryMode, syncRecoveryNow } from './recovery'

export type StorageMode = 'trusted' | 'trustless'

const STORAGE_MODE_KEY = 'mosaic.storageMode'

interface StorageModeState {
  mode: StorageMode
  trusted: boolean
  connecting: boolean
  error: string | null
  setMode: (mode: StorageMode) => Promise<void>
}

const Ctx = createContext<StorageModeState | null>(null)

function initialMode(): StorageMode {
  try {
    return localStorage.getItem(STORAGE_MODE_KEY) === 'trusted' ? 'trusted' : 'trustless'
  } catch {
    return 'trustless'
  }
}

function persistMode(mode: StorageMode) {
  try {
    localStorage.setItem(STORAGE_MODE_KEY, mode)
  } catch {
    // In-memory mode still works if localStorage is unavailable.
  }
}

export function StorageModeProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet()
  const [mode, setModeState] = useState<StorageMode>(() => {
    const next = initialMode()
    setRecoveryMode(next)
    setRecoveryBackendEnabled(next === 'trusted')
    return next
  })
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setRecoveryMode(mode)
    setRecoveryBackendEnabled(mode === 'trusted')
  }, [mode])

  useEffect(() => {
    if (!wallet.ready) return
    if (wallet.address) return
    if (mode !== 'trusted') return
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setRecoveryMode('trustless')
      setRecoveryBackendEnabled(false)
      resetApiCaches()
      setModeState('trustless')
      persistMode('trustless')
      void api.deleteAuthSession().catch(() => {})
    })
    return () => {
      active = false
    }
  }, [mode, wallet.address, wallet.ready])

  useEffect(() => {
    if (mode !== 'trusted' || !wallet.ready || !wallet.address || !wallet.networkPassphrase) return
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setConnecting(true)
      setError(null)
      ensureBackendSession(wallet.address!, wallet.networkPassphrase!)
        .then(async () => {
          if (!active) return
          setRecoveryMode('trusted')
          setRecoveryBackendEnabled(true)
          await syncRecoveryNow().catch(() => {})
        })
        .catch((e) => {
          if (!active) return
          setRecoveryMode('trustless')
          setRecoveryBackendEnabled(false)
          resetApiCaches()
          setModeState('trustless')
          persistMode('trustless')
          setError(errorMessage(e))
        })
        .finally(() => {
          if (active) setConnecting(false)
        })
    })
    return () => {
      active = false
    }
  }, [mode, wallet.address, wallet.networkPassphrase, wallet.ready])

  const setMode = useCallback(async (next: StorageMode) => {
    if (next === mode) return
    setConnecting(true)
    setError(null)
    try {
      if (next === 'trusted') {
        if (!wallet.address || !wallet.networkPassphrase) {
          throw new Error('Connect Freighter on Stellar Testnet first.')
        }
        await ensureBackendSession(wallet.address, wallet.networkPassphrase)
        setRecoveryMode(next)
        setRecoveryBackendEnabled(true)
        await syncRecoveryNow().catch(() => {})
      } else {
        setRecoveryMode(next)
        setRecoveryBackendEnabled(false)
      }
      resetApiCaches()
      setModeState(next)
      persistMode(next)
      window.dispatchEvent(new CustomEvent('mosaic-storage-mode-changed', { detail: { mode: next } }))
    } catch (e) {
      if (next === 'trusted') setRecoveryBackendEnabled(false)
      setError(errorMessage(e))
      throw e
    } finally {
      setConnecting(false)
    }
  }, [mode, wallet.address, wallet.networkPassphrase])

  const value = useMemo<StorageModeState>(() => ({
    mode,
    trusted: mode === 'trusted',
    connecting,
    error,
    setMode,
  }), [mode, connecting, error, setMode])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStorageMode(): StorageModeState {
  const value = useContext(Ctx)
  if (!value) throw new Error('useStorageMode outside StorageModeProvider')
  return value
}
