import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, type Desk } from '../api'
import { useWallet } from '../WalletContext'
import BookView from '../components/BookView'
import ShieldForm from '../components/ShieldForm'
import OrderForm from '../components/OrderForm'
import { notesForDesk, reconcile, type Note } from '../notes'

export default function DeskPage() {
  const { deskId } = useParams()
  const { address } = useWallet()
  const [desk, setDesk] = useState<Desk | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [error, setError] = useState<string | null>(null)

  const reloadNotes = useCallback(() => {
    if (deskId) notesForDesk(deskId).then(setNotes)
  }, [deskId])

  useEffect(() => {
    if (!deskId) return
    api.getDesk(deskId).then(setDesk).catch((e) => setError(String(e)))
    reloadNotes()
  }, [deskId, reloadNotes])

  // Auto-refresh the on-chain root every 5s as a liveness signal.
  useEffect(() => {
    if (!deskId) return
    let alive = true
    const tick = () =>
      api
        .getRoot(deskId)
        .then((r) => alive && setRoot(r.root))
        .catch(() => {})
    tick()
    const h = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [deskId])

  // Reconcile local notes against on-chain state every 7s so filled proceeds appear.
  useEffect(() => {
    if (!deskId) return
    let alive = true
    const tick = () =>
      api
        .getNotes(deskId)
        .then(async (r) => {
          if (!alive) return
          if (await reconcile(deskId, r.notes)) reloadNotes()
        })
        .catch(() => {})
    tick()
    const h = setInterval(tick, 7000)
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [deskId, reloadNotes])

  if (error) return <p className="err">{error}</p>
  if (!desk) return <p className="muted">Loading…</p>

  const sym = (id: number) => desk.assets.find((a) => a.asset_id === id)?.symbol ?? `#${id}`

  return (
    <>
      <h2>{desk.name}</h2>

      <h2>Address book — desk</h2>
      <table>
        <tbody>
          <tr>
            <th>Contract</th>
            <td className="mono">{desk.contract_id}</td>
          </tr>
          <tr>
            <th>Sponsor (main)</th>
            <td className="mono">{desk.sponsor_pubkey || <span className="muted">—</span>}</td>
          </tr>
          <tr>
            <th>Tree root</th>
            <td className="mono">{root ?? '…'}</td>
          </tr>
          {desk.assets.map((a) => (
            <tr key={a.asset_id}>
              <th>
                {a.symbol} (id {a.asset_id})
              </th>
              <td className="mono">{a.token}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Shield</h2>
      {address ? (
        <ShieldForm desk={desk} userPubkey={address} onDone={reloadNotes} />
      ) : (
        <p className="muted">Connect your wallet to shield assets.</p>
      )}

      <h2>Place limit order</h2>
      {address ? (
        <OrderForm desk={desk} notes={notes} onDone={reloadNotes} />
      ) : (
        <p className="muted">Connect your wallet to place orders.</p>
      )}

      <h2>Address book — my notes</h2>
      {balances(notes).length > 0 && (
        <p>
          {balances(notes).map(([s, amt]) => (
            <span className="pill" key={s}>
              {s} {amt}
            </span>
          ))}
        </p>
      )}
      {notes.length === 0 ? (
        <p className="muted">No notes yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Asset</th>
              <th>Amount</th>
              <th>Owner tag</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {notes.map((n) => (
              <tr key={n.id}>
                <td>{n.symbol}</td>
                <td>{n.amount}</td>
                <td className="mono">{n.owner_tag.slice(0, 14)}…</td>
                <td className={n.status === 'spent' ? 'muted' : 'ok'}>{n.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Order book</h2>
      {desk.pairs.length === 0 && <p className="muted">No pairs registered.</p>}
      {desk.pairs.map((p) => (
        <div className="card" key={p.pair_id}>
          <h3>
            {sym(p.base_asset)}/{sym(p.quote_asset)} <span className="muted">· pair {p.pair_id}</span>
          </h3>
          <div className="row">
            <BookView deskId={desk.id} pairId={p.pair_id} side={1} label="Asks (sell base)" />
            <BookView deskId={desk.id} pairId={p.pair_id} side={0} label="Bids (buy base)" />
          </div>
        </div>
      ))}
    </>
  )
}

/** Spendable shielded balance per asset symbol, summed from confirmed (unspent) notes. */
function balances(notes: Note[]): [string, string][] {
  const m = new Map<string, bigint>()
  for (const n of notes) {
    if (n.status === 'spent') continue
    m.set(n.symbol, (m.get(n.symbol) ?? 0n) + BigInt(n.amount))
  }
  return [...m.entries()].map(([s, v]) => [s, v.toString()])
}
