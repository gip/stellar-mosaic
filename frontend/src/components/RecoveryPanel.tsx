import { useEffect, useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { Link } from 'react-router-dom'
import { useWallet } from '../WalletContext'
import { useRecovery } from '../RecoveryContext'

// Returns true only once `value` has stayed true continuously for `delayMs`; falls back to false the
// moment `value` clears. State is only set from inside timers (never synchronously in the effect
// body) to satisfy react-hooks/set-state-in-effect.
function useSettled(value: boolean, delayMs: number): boolean {
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const handle = window.setTimeout(() => setSettled(value), value ? delayMs : 0)
    return () => window.clearTimeout(handle)
  }, [value, delayMs])
  return settled
}

export function RecoveryNotice() {
  const { address } = useWallet()
  const recovery = useRecovery()
  const [error, setError] = useState<string | null>(null)

  const visibleError = error ?? recovery.error
  // The demo auto-establishes a local recovery session, so `unlocked` briefly dips false (and
  // `syncing` briefly toggles) during account re-selection, mode switches, and note operations.
  // Debounce the non-error notice so that momentary re-establishment doesn't flash the banner; real
  // errors still surface immediately.
  const pendingNotice = useSettled(!!address && !visibleError && (!recovery.unlocked || recovery.syncing), 700)

  if (!address || (!visibleError && !pendingNotice)) return null

  async function run(fn: () => Promise<void>) {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const tone = visibleError ? 'err' : recovery.unlocked ? 'info' : 'warn'
  const message = visibleError
    ? visibleError
    : recovery.unlocked
      ? 'Private-note recovery is synchronizing.'
      : 'Private-note recovery is required before creating new notes.'

  return (
    <div className={`banner ${tone} recovery-notice`} role={tone === 'err' ? 'alert' : 'status'}>
      <div className="banner-body">
        <strong>Private-note recovery</strong>
        <div>{message}</div>
      </div>
      <div className="recovery-notice-actions">
        {!recovery.unlocked && (
          <button type="button" disabled={recovery.syncing} onClick={() => run(recovery.unlock)}>
            {recovery.syncing ? 'Enabling…' : 'Enable'}
          </button>
        )}
        {recovery.unlocked && recovery.error && (
          <button type="button" disabled={recovery.syncing} onClick={() => run(recovery.sync)}>
            Retry sync
          </button>
        )}
        <Link className="button-link" to="/settings">
          Settings
        </Link>
      </div>
    </div>
  )
}

export default function RecoveryPanel() {
  const { address } = useWallet()

  if (!address) return null

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <strong>Private-note recovery</strong>{' '}
      <span className="warn">demo only</span>
      <p className="muted">
        This is a demo. Your private notes live only in this browser and are never backed up
        anywhere. Mosaic notes are UTXO-style — whoever holds a note's secret owns the funds, and a
        note cannot be reconstructed from the chain. Clearing browser storage or losing this device
        means the notes, and the funds they represent, are gone for good.
      </p>
      <p className="muted">
        A production system must implement a real backup strategy (for example a
        wallet-signature–derived encryption key with encrypted off-device backups) before it can be
        trusted with real value.
      </p>
    </section>
  )
}
