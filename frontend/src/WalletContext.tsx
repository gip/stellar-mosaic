import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { connect as fxConnect, currentAddress, network as currentNetwork } from './wallet'
import { reconcileDirectSubmissions } from './directTransaction'
import { Networks } from '@stellar/stellar-sdk'

const DISCONNECTED_KEY = 'stellar-mosaic.wallet-disconnected'

interface WalletState {
  address: string | null
  ready: boolean
  connecting: boolean
  error: string | null
  networkPassphrase: string | null
  connect: () => Promise<void>
  disconnect: () => Promise<void>
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
  const [ready, setReady] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [networkPassphrase, setNetworkPassphrase] = useState<string | null>(null)
  const disconnected = useRef(isLocallyDisconnected())

  useEffect(() => {
    void reconcileDirectSubmissions()
    let active = true

    async function refresh() {
      if (disconnected.current) {
        setReady(true)
        return
      }
      try {
        const [nextAddress, nextNetwork] = await Promise.all([currentAddress(), currentNetwork()])
        if (!active || disconnected.current) return
        if (nextAddress && nextNetwork?.networkPassphrase === Networks.TESTNET) {
          setAddress(nextAddress)
          setNetworkPassphrase(nextNetwork.networkPassphrase)
          setError(null)
        } else {
          setAddress(null)
          setNetworkPassphrase(null)
          if (nextAddress) setError('Switch Freighter to Stellar Testnet to sign in.')
        }
      } finally {
        if (active) setReady(true)
      }
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
      const nextNetwork = await currentNetwork()
      if (nextNetwork?.networkPassphrase !== Networks.TESTNET) {
        throw new Error('Switch Freighter to Stellar Testnet to sign in.')
      }
      disconnected.current = false
      storeDisconnected(false)
      setAddress(nextAddress)
      setNetworkPassphrase(nextNetwork.networkPassphrase)
      setReady(true)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setConnecting(false)
    }
  }

  async function disconnect() {
    disconnected.current = true
    storeDisconnected(true)
    setAddress(null)
    setNetworkPassphrase(null)
    setError(null)
  }

  return (
    <Ctx.Provider value={{ address, ready, networkPassphrase, connecting, error, connect, disconnect }}>
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
