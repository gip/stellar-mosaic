import { useMemo, useState } from 'react'
import type { Desk, Pair } from '../api'
import { api } from '../api'
import { randomField } from '../crypto'
import { orderTerms } from '../noir'
import { proveLift, b64 } from '../prove'
import { addNote, updateNote, type Note } from '../notes'

type Side = 'SELL' | 'BUY'

/**
 * Place a resting limit order. Consumes one shielded asset note in full, derives the order's public
 * fields + a fresh proceeds tag, proves the lift circuit in-browser, and relays a fully-sponsored
 * submit_order. On success the consumed note is marked spent and a pending proceeds note is saved.
 */
export default function OrderForm({
  desk,
  notes,
  onDone,
}: {
  desk: Desk
  notes: Note[]
  onDone: () => void
}) {
  const [pairId, setPairId] = useState(desk.pairs[0]?.pair_id ?? 0)
  const [side, setSide] = useState<Side>('SELL')
  const [noteId, setNoteId] = useState('')
  const [minOut, setMinOut] = useState('1000')
  const [partial, setPartial] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pair = desk.pairs.find((p) => p.pair_id === pairId) as Pair | undefined
  // SELL = give base / want quote; BUY = give quote / want base.
  const assetIn = pair ? (side === 'SELL' ? pair.base_asset : pair.quote_asset) : 0
  const assetOut = pair ? (side === 'SELL' ? pair.quote_asset : pair.base_asset) : 0
  const sym = (id: number) => desk.assets.find((a) => a.asset_id === id)?.symbol ?? `#${id}`

  // Spendable notes whose asset matches what this order offers (full-consumption).
  const eligible = useMemo(
    () => notes.filter((n) => n.status === 'confirmed' && n.asset_id === assetIn),
    [notes, assetIn],
  )
  const note = eligible.find((n) => n.id === noteId) ?? eligible[0]

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!note) {
      setError(`No spendable ${sym(assetIn)} note to offer.`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const expiry = Math.floor(Date.now() / 1000) + 7 * 86400
      const rho_out = randomField()
      const rho_ord = randomField()
      setStatus('Deriving order terms…')
      const terms = await orderTerms({
        sk: note.sk,
        rho_in: note.rho,
        rho_out,
        rho_ord,
        asset_in: assetIn,
        amount_in: note.amount,
        asset_out: assetOut,
        min_out: minOut,
        expiry,
        partial_allowed: partial ? 1 : 0,
      })
      setStatus('Fetching membership path…')
      const proof = await api.getNoteProof(desk.id, note.owner_tag)
      setStatus('Proving (UltraHonk, in-browser)…')
      const bundle = await proveLift({
        rho_in: note.rho,
        sk_o: note.sk,
        path: proof.siblings,
        index_bits: proof.index_bits,
        root: proof.root,
        nullifier_in: terms.nullifier_in,
        asset_in: assetIn,
        amount_in: note.amount,
        asset_out: assetOut,
        min_out: minOut,
        output_owner_tag: terms.output_owner_tag,
        cancel_owner_tag: terms.cancel_owner_tag,
        expiry,
        partial_allowed: partial ? 1 : 0,
        order_leaf: terms.order_leaf,
      })
      setStatus('Submitting (sponsored)…')
      await api.relayOrder(desk.id, b64(bundle.proof), b64(bundle.publicInputs))

      // The offered note is now spent; record a pending proceeds note (asset_out @ output tag).
      await updateNote(note.id, { status: 'spent' })
      await addNote({
        id: crypto.randomUUID(),
        deskId: desk.id,
        role: 'order-output',
        asset_id: assetOut,
        symbol: sym(assetOut),
        amount: minOut,
        sk: note.sk,
        rho: rho_out,
        owner_tag: terms.output_owner_tag,
        status: 'pending',
        createdAt: Date.now(),
      })
      setStatus('Order submitted.')
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="row" style={{ alignItems: 'flex-end' }}>
      <div>
        <label>Pair</label>
        <select value={pairId} onChange={(e) => setPairId(Number(e.target.value))}>
          {desk.pairs.map((p) => (
            <option key={p.pair_id} value={p.pair_id}>
              {sym(p.base_asset)}/{sym(p.quote_asset)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label>Side</label>
        <select value={side} onChange={(e) => setSide(e.target.value as Side)}>
          <option value="SELL">SELL {pair && sym(pair.base_asset)}</option>
          <option value="BUY">BUY {pair && sym(pair.base_asset)}</option>
        </select>
      </div>
      <div>
        <label>Offer note ({sym(assetIn)})</label>
        <select value={note?.id ?? ''} onChange={(e) => setNoteId(e.target.value)}>
          {eligible.length === 0 && <option value="">none</option>}
          {eligible.map((n) => (
            <option key={n.id} value={n.id}>
              {n.amount} {n.symbol} · {n.owner_tag.slice(0, 10)}…
            </option>
          ))}
        </select>
      </div>
      <div>
        <label>Min out ({sym(assetOut)})</label>
        <input value={minOut} onChange={(e) => setMinOut(e.target.value)} inputMode="numeric" />
      </div>
      <div>
        <label>
          <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />{' '}
          partial
        </label>
      </div>
      <button type="submit" disabled={busy || !note}>
        {busy ? 'Working…' : 'Place order'}
      </button>
      {status && <span className="muted">{status}</span>}
      {error && <span className="err">{error}</span>}
    </form>
  )
}
