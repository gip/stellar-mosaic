import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useWallet } from './WalletContext'
import {
  exportRecoveryFile,
  importRecoveryFile,
  recoveryStatus,
  selectRecoveryAccount,
  syncRecoveryNow,
  subscribeRecovery,
  unlockRecovery,
  type RecoveryFile,
  type RecoveryStatus,
} from './recovery'

interface RecoveryContextValue extends RecoveryStatus {
  unlock: () => Promise<void>
  exportFile: () => Promise<void>
  importFile: (file: File) => Promise<number>
  sync: () => Promise<void>
}

const Ctx = createContext<RecoveryContextValue | null>(null)

export function RecoveryProvider({ children }: { children: ReactNode }) {
  const { address, networkPassphrase } = useWallet()
  const [status, setStatus] = useState<RecoveryStatus>(recoveryStatus())

  useEffect(() => subscribeRecovery(setStatus), [])
  useEffect(() => {
    selectRecoveryAccount(address, networkPassphrase).catch(() => {})
  }, [address, networkPassphrase])

  async function unlock() {
    if (!address || !networkPassphrase) throw new Error('Connect Freighter to a Stellar network first.')
    await unlockRecovery(address, networkPassphrase)
  }

  async function exportFile() {
    const backup = await exportRecoveryFile()
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `stellar-mosaic-${address?.slice(0, 8) ?? 'wallet'}.mosaic-backup`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function importFile(file: File) {
    const parsed = JSON.parse(await file.text()) as RecoveryFile
    return importRecoveryFile(parsed)
  }

  return (
    <Ctx.Provider
      value={{ ...status, unlock, exportFile, importFile, sync: syncRecoveryNow }}
    >
      {children}
    </Ctx.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useRecovery(): RecoveryContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useRecovery outside RecoveryProvider')
  return v
}
