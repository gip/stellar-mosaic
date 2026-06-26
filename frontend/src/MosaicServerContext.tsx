import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { api } from './api'
import { ensureBackendSession } from './auth'
import { useWallet } from './WalletContext'
import { setRecoveryBackendEnabled, syncRecoveryNow } from './recovery'

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
  const [trustedAddress, setTrustedAddress] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trusted = !!wallet.address && trustedAddress === wallet.address

  useEffect(() => {
    setRecoveryBackendEnabled(false)
  }, [wallet.address])

  async function trust() {
    setConnecting(true)
    setError(null)
    try {
      if (!wallet.address || !wallet.networkPassphrase) throw new Error('Connect Freighter on Stellar Testnet first.')
      await ensureBackendSession(wallet.address, wallet.networkPassphrase)
      setRecoveryBackendEnabled(true)
      await syncRecoveryNow().catch(() => {})
      setTrustedAddress(wallet.address)
    } catch (e) {
      setTrustedAddress(null)
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
      setRecoveryBackendEnabled(false)
      setTrustedAddress(null)
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
