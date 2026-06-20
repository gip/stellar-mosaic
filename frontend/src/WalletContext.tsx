import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { connect as fxConnect, currentAddress, network as currentNetwork } from './wallet'

const DISCONNECTED_KEY = 'stellar-mosaic.wallet-disconnected'

interface WalletState {
  address: string | null
  connecting: boolean
  error: string | null
  networkPassphrase: string | null
  connect: () => Promise<void>
  disconnect: () => void
}

const Ctx = createContext<WalletState | null>(null)

function isLocallyDisconnected(): boolean {
  try {
    return localStorage.getItem(DISCONNECTED_KEY) === 'true'
  } catch {
    return false
  }
}

function storeDisconnected(disconnected: boolean): void {
  try {
    if (disconnected) localStorage.setItem(DISCONNECTED_KEY, 'true')
    else localStorage.removeItem(DISCONNECTED_KEY)
  } catch {
    // React state still provides disconnect behavior if storage is unavailable.
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [networkPassphrase, setNetworkPassphrase] = useState<string | null>(null)
  const disconnected = useRef(isLocallyDisconnected())

  useEffect(() => {
    let active = true

    async function refresh() {
      if (disconnected.current) return
      const [nextAddress, nextNetwork] = await Promise.all([currentAddress(), currentNetwork()])
      if (!active || disconnected.current) return
      setAddress(nextAddress)
      setNetworkPassphrase(nextNetwork?.networkPassphrase ?? null)
    }

    void refresh()
    const h = setInterval(refresh, 3000)
    return () => {
      active = false
      clearInterval(h)
    }
  }, [])

  async function connect() {
    setConnecting(true)
    setError(null)
    try {
      const nextAddress = await fxConnect()
      disconnected.current = false
      storeDisconnected(false)
      setAddress(nextAddress)
      setNetworkPassphrase((await currentNetwork())?.networkPassphrase ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setConnecting(false)
    }
  }

  function disconnect() {
    disconnected.current = true
    storeDisconnected(true)
    setAddress(null)
    setNetworkPassphrase(null)
    setError(null)
  }

  return (
    <Ctx.Provider value={{ address, networkPassphrase, connecting, error, connect, disconnect }}>
      {children}
    </Ctx.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWallet(): WalletState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useWallet outside WalletProvider')
  return v
}
