import { createContext, useContext, type ReactNode } from 'react'
import { useStorageMode } from './StorageModeContext'

interface MosaicServerState {
  trusted: boolean
  connecting: boolean
  error: string | null
  trust: () => Promise<void>
}

const Ctx = createContext<MosaicServerState | null>(null)

export function MosaicServerProvider({ children }: { children: ReactNode }) {
  const storageMode = useStorageMode()

  async function trust() {
    await storageMode.setMode('trusted')
  }

  return (
    <Ctx.Provider value={{
      trusted: storageMode.trusted,
      connecting: storageMode.connecting,
      error: storageMode.error,
      trust,
    }}>
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
