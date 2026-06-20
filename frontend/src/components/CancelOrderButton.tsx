import { useState } from 'react'
import type { Desk } from '../api'
import { api } from '../api'
import { randomField } from '../crypto'
import { noteTag } from '../noir'
import { proveCancel, b64 } from '../prove'
import { updateNote, type Note } from '../notes'
import { stageRecoverableNote, syncRecoveryNow } from '../recovery'
import { useRecovery } from '../RecoveryContext'

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
  const recoveryReady = recovery.unlocked && !recovery.error

  const c = note.cancel
  if (!c || note.status !== 'active') return null

  async function cancel() {
    if (!c) return
    setBusy(true)
    setError(null)
    try {
      const rho_return = randomField()
      setStatus('Deriving return tag…')
      const return_owner_tag = await noteTag(note.sk, rho_return)
      setStatus('Proving (UltraHonk, in-browser)…')
      const bundle = await proveCancel({
        sk_o: note.sk,
        rho_ord: c.rho_ord,
        order_leaf: c.order_leaf,
        cancel_owner_tag: c.cancel_owner_tag,
        return_owner_tag,
      })
      const refund: Note = {
        id: crypto.randomUUID(),
        deskId: desk.id,
        role: 'asset',
        asset_id: c.asset_in,
        symbol: c.symbol_in,
        amount: c.amount_in,
        sk: note.sk,
        rho: rho_return,
        owner_tag: return_owner_tag,
        status: 'active',
        indexed: false,
        createdAt: Date.now(),
      }
      setStatus('Backing up refund secrets…')
      await stageRecoverableNote(refund)
      setStatus('Submitting (sponsored)…')
      await api.relayCancel(desk.id, c.pairId, c.side, b64(bundle.proof), b64(bundle.publicInputs))

      await updateNote(note.id, { status: 'cancelled', cancelledAt: Date.now() })
      await syncRecoveryNow()
      setStatus('Cancelled.')
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
