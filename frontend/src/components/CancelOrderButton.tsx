import { useState } from 'react'
import type { Desk } from '../api'
import type { Note } from '../notes'
import { useRecovery } from '../RecoveryContext'
import { useActivity } from '../ActivityContext'

/**
 * Cancel a resting limit order. Derives a fresh return destination, proves the cancel circuit
 * in-browser (authority over the order's cancel tag, bound to this order + payout), and relays a
 * fully-sponsored cancel_order. On success the order note is marked cancelled and an active refund
 * note (the locked asset_in) is saved — it becomes spendable once indexed on-chain.
 */
export default function CancelOrderButton({
  desk,
  note,
  onDone,
}: {
  desk: Desk
  note: Note
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recovery = useRecovery()
  const activity = useActivity()
  const recoveryReady = recovery.unlocked && !recovery.error

  const c = note.cancel
  if (!c || note.status !== 'active') return null

  async function cancel() {
    if (!c) return
    setBusy(true)
    setError(null)
    try {
      setStatus('Queueing cancellation…')
      const operation = await activity.enqueue({ kind: 'cancel_order', desk_id: desk.id, wallet_note_id: note.id })
      setStatus(`Queued · ${operation.id.slice(0, 8)}`)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" onClick={cancel} disabled={busy || !recoveryReady}>
        {busy ? 'Working…' : recoveryReady ? 'Cancel' : 'Repair recovery to cancel'}
      </button>
      {status && <span className="muted"> {status}</span>}
      {error && <span className="err"> {error}</span>}
    </>
  )
}
