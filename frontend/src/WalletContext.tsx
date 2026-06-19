import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { connect as fxConnect, currentAddress } from './wallet'

interface WalletState {
  address: string | null
  connecting: boolean
  error: string | null
  connect: () => Promise<void>
}

const Ctx = createContext<WalletState | null>(null)

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    currentAddress().then(setAddress)
  }, [])

  async function connect() {
    setConnecting(true)
    setError(null)
    try {
      setAddress(await fxConnect())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setConnecting(false)
    }
  }

  return <Ctx.Provider value={{ address, connecting, error, connect }}>{children}</Ctx.Provider>
}

export function useWallet(): WalletState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useWallet outside WalletProvider')
  return v
}
