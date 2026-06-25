import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Address } from 'viem'
import {
  baseEthBalance,
  connectBase,
  currentBaseAccount,
  currentChainId,
  ethereumProvider,
} from './base'
import { useWallet } from './WalletContext'

const BASE_SEPOLIA_CHAIN_ID = 84_532
const DISCONNECTED_KEY = 'stellar-mosaic.ethereum-disconnected'

interface EthereumWalletState {
  address: Address | null
  chainId: number | null
  balance: bigint | null
  connectedToBase: boolean
  connecting: boolean
  error: string | null
  connect: () => Promise<void>
  disconnect: () => void
  refreshBalance: () => Promise<void>
}

const Ctx = createContext<EthereumWalletState | null>(null)

function locallyDisconnected(): boolean {
  try {
    return localStorage.getItem(DISCONNECTED_KEY) === 'true'
  } catch {
    return false
  }
}

export function EthereumWalletProvider({ children }: { children: ReactNode }) {
  const stellar = useWallet()
  const [address, setAddress] = useState<Address | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [balance, setBalance] = useState<bigint | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clear = useCallback(() => {
    setAddress(null)
    setChainId(null)
    setBalance(null)
    setError(null)
  }, [])

  const refreshBalance = useCallback(async () => {
    if (!address || chainId !== BASE_SEPOLIA_CHAIN_ID) {
      setBalance(null)
      return
    }
    setBalance(await baseEthBalance(address))
  }, [address, chainId])

  useEffect(() => {
    if (!stellar.ready) return
    if (!stellar.address) {
      try { localStorage.setItem(DISCONNECTED_KEY, 'true') } catch { /* state still clears */ }
      queueMicrotask(clear)
      return
    }
    if (locallyDisconnected()) return
    Promise.all([currentBaseAccount(), currentChainId()])
      .then(([account, selectedChain]) => {
        setAddress(account)
        setChainId(selectedChain)
      })
      .catch(() => {})
  }, [stellar.address, stellar.ready, clear])

  useEffect(() => {
    let provider: ReturnType<typeof ethereumProvider>
    try { provider = ethereumProvider() } catch { return }
    const accountsChanged = (...args: unknown[]) => {
      const accounts = args[0] as Address[]
      setAddress(accounts?.[0] ?? null)
      setBalance(null)
    }
    const chainChanged = (...args: unknown[]) => {
      setChainId(Number.parseInt(String(args[0]), 16))
      setBalance(null)
    }
    const providerDisconnected = () => clear()
    provider.on?.('accountsChanged', accountsChanged)
    provider.on?.('chainChanged', chainChanged)
    provider.on?.('disconnect', providerDisconnected)
    return () => {
      provider.removeListener?.('accountsChanged', accountsChanged)
      provider.removeListener?.('chainChanged', chainChanged)
      provider.removeListener?.('disconnect', providerDisconnected)
    }
  }, [clear])

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshBalance().catch(() => setBalance(null)), 0)
    return () => window.clearTimeout(timer)
  }, [refreshBalance])

  async function connect() {
    if (!stellar.address) throw new Error('Connect Stellar Testnet first.')
    setConnecting(true)
    setError(null)
    try {
      const account = await connectBase()
      const selectedChain = await currentChainId()
      if (selectedChain !== BASE_SEPOLIA_CHAIN_ID) {
        throw new Error('Switch MetaMask to Base Sepolia to continue.')
      }
      try { localStorage.removeItem(DISCONNECTED_KEY) } catch { /* state still connects */ }
      setAddress(account)
      setChainId(selectedChain)
      setBalance(await baseEthBalance(account))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    } finally {
      setConnecting(false)
    }
  }

  function disconnect() {
    try { localStorage.setItem(DISCONNECTED_KEY, 'true') } catch { /* state still clears */ }
    clear()
  }

  return (
    <Ctx.Provider value={{
      address,
      chainId,
      balance,
      connectedToBase: !!address && chainId === BASE_SEPOLIA_CHAIN_ID,
      connecting,
      error,
      connect,
      disconnect,
      refreshBalance,
    }}>
      {children}
    </Ctx.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useEthereumWallet(): EthereumWalletState {
  const value = useContext(Ctx)
  if (!value) throw new Error('useEthereumWallet outside EthereumWalletProvider')
  return value
}
