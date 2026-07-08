import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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

// The explicit preference the user picked with the toggle, or null if they never chose one.
// Forced fallbacks (logged out, session failure) must not masquerade as a choice here.
function storedMode(): StorageMode | null {
  try {
    const raw = localStorage.getItem(STORAGE_MODE_KEY)
    return raw === 'trusted' || raw === 'trustless' ? raw : null
  } catch {
    return null
  }
}

function initialMode(): StorageMode {
  return storedMode() ?? 'trusted'
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
  // Wallet address whose trusted-session attempt failed (MCP unreachable, auth error). While set,
  // the login auto-promotion below must not push this wallet back into Trusted mode — with the
  // server down the forced trustless fallback and the promotion would otherwise oscillate the mode
  // forever, re-rendering the app and hammering the dead server on every flip. Cleared on a
  // successful session; a different address never matches, so a new login retries Trusted, and the
  // explicit toggle (`setMode('trusted')`) always retries.
  const sessionFailedFor = useRef<string | null>(null)

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
      // In-memory only: logging out is not a mode choice, so the trusted default (or an
      // explicit stored preference) still applies at the next login.
      setModeState('trustless')
      void api.deleteAuthSession().catch(() => {})
    })
    return () => {
      active = false
    }
  }, [mode, wallet.address, wallet.ready])

  // Logging in lands in Trusted mode unless the user explicitly chose Trustless.
  useEffect(() => {
    if (!wallet.ready || !wallet.address) return
    if (mode === 'trusted') return
    if (storedMode() === 'trustless') return
    if (sessionFailedFor.current === wallet.address) return
    let active = true
    queueMicrotask(() => {
      if (!active) return
      resetApiCaches()
      setModeState('trusted')
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
          sessionFailedFor.current = null
          setRecoveryMode('trusted')
          setRecoveryBackendEnabled(true)
          await syncRecoveryNow().catch(() => {})
        })
        .catch((e) => {
          if (!active) return
          sessionFailedFor.current = wallet.address
          setRecoveryMode('trustless')
          setRecoveryBackendEnabled(false)
          resetApiCaches()
          // In-memory only: a session failure is a forced fallback, not a user choice, so the
          // trusted default still applies at the next login.
          setModeState('trustless')
          setError(`Mosaic server is unreachable — staying in Trustless mode. (${errorMessage(e)})`)
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
        sessionFailedFor.current = null
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
      if (next === 'trusted') {
        sessionFailedFor.current = wallet.address
        setRecoveryBackendEnabled(false)
      }
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
