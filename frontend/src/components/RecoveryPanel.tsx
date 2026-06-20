import { useRef, useState } from 'react'
import { useWallet } from '../WalletContext'
import { useRecovery } from '../RecoveryContext'

export default function RecoveryPanel() {
  const { address } = useWallet()
  const recovery = useRecovery()
  const fileRef = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!address) return null

  async function run(fn: () => Promise<void>) {
    setError(null)
    setMessage(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <strong>Private-note recovery</strong>{' '}
      {recovery.unlocked ? (
        <span className="ok">enabled for this wallet</span>
      ) : (
        <span className="warn">required before creating new notes</span>
      )}
      <p className="muted">
        Freighter derives the encryption key. Never sign the Mosaic recovery message on another
        site. Legacy notes created before this feature remain local-only.
      </p>
      <div className="row">
        {!recovery.unlocked && (
          <button disabled={recovery.syncing} onClick={() => run(recovery.unlock)}>
            {recovery.syncing ? 'Enabling…' : 'Enable / restore recovery'}
          </button>
        )}
        {recovery.unlocked && (
          <>
            {recovery.error && (
              <button disabled={recovery.syncing} onClick={() => run(recovery.sync)}>
                Retry encrypted sync
              </button>
            )}
            <button disabled={recovery.syncing} onClick={() => run(recovery.exportFile)}>
              Export encrypted backup
            </button>
            <button disabled={recovery.syncing} onClick={() => fileRef.current?.click()}>
              Import encrypted backup
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".mosaic-backup,application/json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                run(async () => {
                  const count = await recovery.importFile(file)
                  setMessage(`Imported ${count} recoverable note record${count === 1 ? '' : 's'}.`)
                })
                e.target.value = ''
              }}
            />
          </>
        )}
        {recovery.syncing && <span className="muted">Synchronizing…</span>}
        {message && <span className="ok">{message}</span>}
        {(error || recovery.error) && <span className="err">{error ?? recovery.error}</span>}
      </div>
    </section>
  )
}
