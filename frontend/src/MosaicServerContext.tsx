import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { api } from './api'
import { ensureBackendSession } from './auth'
import { useWallet } from './WalletContext'

interface MosaicServerState {
  trusted: boolean
  connecting: boolean
  error: string | null
  trust: () => Promise<void>
  disconnect: () => Promise<void>
}

const Ctx = createContext<MosaicServerState | null>(null)

export function MosaicServerProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet()
  const [trusted, setTrusted] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    async function refresh() {
      if (!wallet.address) {
        setTrusted(false)
        setError(null)
        return
      }
      const session = await api.mcp().session().catch(() => null)
      if (!active) return
      setTrusted(session?.address === wallet.address)
      if (session?.address !== wallet.address) setError(null)
    }
    void refresh()
    return () => {
      active = false
    }
  }, [wallet.address])

  async function trust() {
    setConnecting(true)
    setError(null)
    try {
      if (!wallet.address || !wallet.networkPassphrase) throw new Error('Connect Freighter on Stellar Testnet first.')
      await ensureBackendSession(wallet.address, wallet.networkPassphrase)
      setTrusted(true)
    } catch (e) {
      setTrusted(false)
      setError(errorMessage(e))
    } finally {
      setConnecting(false)
    }
  }

  async function disconnect() {
    setConnecting(true)
    setError(null)
    try {
      await api.deleteAuthSession().catch(() => {})
      setTrusted(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setConnecting(false)
    }
  }

  return (
    <Ctx.Provider value={{ trusted, connecting, error, trust, disconnect }}>
      {children}
    </Ctx.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useMosaicServer(): MosaicServerState {
  const value = useContext(Ctx)
  if (!value) throw new Error('useMosaicServer outside MosaicServerProvider')
  return value
}
