import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { ensureBackendSession } from './auth'
import { useWallet } from './WalletContext'
import { api, resetApiCaches } from './api'
import { setRecoveryBackendEnabled, setRecoveryMode, syncRecoveryNow } from './recovery'

export type StorageMode = 'trusted' | 'trustless' | 'agent'
export type TradingMode = 'trusted' | 'trustless'

const STORAGE_MODE_KEY = 'mosaic.storageMode'

interface StorageModeState {
  mode: StorageMode
  trusted: boolean
  connecting: boolean
  error: string | null
  /** The trading mode the nav restores when leaving the agent console. */
  lastTradingMode: TradingMode
  setMode: (mode: StorageMode) => Promise<void>
}

const Ctx = createContext<StorageModeState | null>(null)

// The trading mode the user last picked with the toggle, or null if they never chose one.
// Agent mode is never persisted (it is derived from being on /agents), and forced fallbacks
// (logged out, session failure) must not masquerade as a choice here.
function storedMode(): TradingMode | null {
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

function persistMode(mode: TradingMode) {
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
  const [lastTradingMode, setLastTradingMode] = useState<TradingMode>(() => storedMode() ?? 'trusted')

  // Every mode change goes through here so "last used" tracks whatever trading mode is active,
  // forced fallbacks included.
  const applyMode = useCallback((next: StorageMode) => {
    setModeState(next)
    if (next !== 'agent') setLastTradingMode(next)
  }, [])

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
      applyMode('trustless')
      void api.deleteAuthSession().catch(() => {})
    })
    return () => {
      active = false
    }
  }, [applyMode, mode, wallet.address, wallet.ready])

  // Logging in always lands in Trusted mode first (for now), regardless of the stored
  // preference — that preference only decides which trading mode the nav restores after a
  // visit to the agent console. The ref makes this fire once per login, not on every
  // later mode switch. Landing directly on the agent console is the exception: there the
  // URL decides the mode (App's route→mode sync), so forcing Trusted would fight it.
  const lastLoginRef = useRef<string | null>(null)
  useEffect(() => {
    if (!wallet.ready) return
    if (!wallet.address) {
      lastLoginRef.current = null
      return
    }
    if (lastLoginRef.current === wallet.address) return
    lastLoginRef.current = wallet.address
    if (mode === 'trusted') return
    if (window.location.pathname === '/agents') return
    if (sessionFailedFor.current === wallet.address) return
    let active = true
    queueMicrotask(() => {
      if (!active) return
      resetApiCaches()
      applyMode('trusted')
    })
    return () => {
      active = false
    }
  }, [applyMode, mode, wallet.address, wallet.ready])

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
          applyMode('trustless')
          setError(`Mosaic server is unreachable — staying in Trustless mode. (${errorMessage(e)})`)
        })
        .finally(() => {
          if (active) setConnecting(false)
        })
    })
    return () => {
      active = false
    }
  }, [applyMode, mode, wallet.address, wallet.networkPassphrase, wallet.ready])

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
      applyMode(next)
      if (next !== 'agent') persistMode(next)
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
  }, [applyMode, mode, wallet.address, wallet.networkPassphrase])

  const value = useMemo<StorageModeState>(() => ({
    mode,
    trusted: mode === 'trusted',
    connecting,
    error,
    lastTradingMode,
    setMode,
  }), [mode, connecting, error, lastTradingMode, setMode])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStorageMode(): StorageModeState {
  const value = useContext(Ctx)
  if (!value) throw new Error('useStorageMode outside StorageModeProvider')
  return value
}
