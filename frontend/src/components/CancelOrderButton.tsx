import { useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import type { Desk } from '../api'
import type { Note } from '../notes'
import { useRecovery } from '../RecoveryContext'
import { useActivity } from '../ActivityContext'
import { cancelOrderTrustless } from '../trustless'

/**
 * Cancel a resting limit order. Derives a fresh return destination, proves the cancel circuit
 * in-browser (authority over the order's cancel tag, bound to this order + payout), and relays a
 * fully-sponsored cancel_order. On success the order note is marked cancelled and an active refund
 * note (the locked asset_in) is saved — it becomes spendable once indexed on-chain.
 */
export default function CancelOrderButton({
  desk,
  note,
  userPubkey,
  trustless = false,
  onDone,
}: {
  desk: Desk
  note: Note
  userPubkey: string
  trustless?: boolean
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
      if (trustless) {
        setStatus('Proving cancel…')
        await cancelOrderTrustless(desk, { address: userPubkey, noteId: note.id })
        setStatus('Cancelled')
      } else {
        setStatus('Queueing cancellation…')
        const operation = await activity.enqueue({ kind: 'cancel_order', desk_id: desk.id, wallet_note_id: note.id })
        setStatus(`Queued · ${operation.id.slice(0, 8)}`)
      }
      onDone()
    } catch (e) {
      setError(errorMessage(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="btn-danger btn-sm" type="button" onClick={cancel} disabled={busy || !recoveryReady}>
        {busy ? 'Working…' : recoveryReady ? 'Cancel' : 'Repair recovery'}
      </button>
      {busy && status && (
        <span className="status-dot busy" style={{ marginLeft: 6 }} title={status}>
          {status}
        </span>
      )}
      {!busy && status && !error && (
        <span className="status-dot ok" style={{ marginLeft: 6 }}>
          {status}
        </span>
      )}
      {error && <span className="err"> {error}</span>}
    </>
  )
}
