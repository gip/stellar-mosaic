import { useState } from 'react'
import type { Desk } from '../api'
import { api } from '../api'
import { randomField } from '../crypto'
import { noteTag } from '../noir'
import { proveCancel, b64 } from '../prove'
import { addNote, updateNote, type Note } from '../notes'

/**
 * Cancel a resting limit order. Derives a fresh return destination, proves the cancel circuit
 * in-browser (authority over the order's cancel tag, bound to this order + payout), and relays a
 * fully-sponsored cancel_order. On success the proceeds note is marked cancelled and a pending
 * refund note (the locked asset_in) is saved — it reconciles to the real returned amount on-chain.
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

  const c = note.cancel
  if (!c || note.cancelledAt) return null

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
      setStatus('Submitting (sponsored)…')
      await api.relayCancel(desk.id, c.pairId, c.side, b64(bundle.proof), b64(bundle.publicInputs))

      await updateNote(note.id, { cancelledAt: Date.now() })
      // Refund of the locked asset_in is minted to return_owner_tag; reconcile fills the real amount.
      await addNote({
        id: crypto.randomUUID(),
        deskId: desk.id,
        role: 'asset',
        asset_id: c.asset_in,
        symbol: c.symbol_in,
        amount: c.amount_in,
        sk: note.sk,
        rho: rho_return,
        owner_tag: return_owner_tag,
        status: 'pending',
        createdAt: Date.now(),
      })
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
      <button type="button" onClick={cancel} disabled={busy}>
        {busy ? 'Working…' : 'Cancel'}
      </button>
      {status && <span className="muted"> {status}</span>}
      {error && <span className="err"> {error}</span>}
    </>
  )
}
