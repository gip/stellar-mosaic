import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, type Desk } from '../api'
import { useWallet } from '../WalletContext'
import BookView from '../components/BookView'
import ShieldForm from '../components/ShieldForm'
import OrderForm from '../components/OrderForm'
import CancelOrderButton from '../components/CancelOrderButton'
import { notesForDesk, reconcile, type Note } from '../notes'
import { formatAmount } from '../amount'

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
  const dec = (id: number) => desk.assets.find((a) => a.asset_id === id)?.decimals ?? 7

  // Split into active/pending vs spent; within each, most-recently-modified first. Spent renders
  // last (its own collapsed section), so spent notes always sort to the end of the list.
  const active = notes.filter((n) => n.status !== 'spent').sort((a, b) => mtime(b) - mtime(a))
  const spent = notes.filter((n) => n.status === 'spent').sort((a, b) => mtime(b) - mtime(a))

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
      {notes.length === 0 ? (
        <p className="muted">No notes yet.</p>
      ) : (
        <>
          {balances(notes, dec).length > 0 && (
            <p>
              {balances(notes, dec).map(([s, amt]) => (
                <span className="pill" key={s}>
                  {s} {amt}
                </span>
              ))}
            </p>
          )}
          {active.length > 0 && (
            <details>
              <summary>Active &amp; pending notes ({active.length})</summary>
              <NotesTable notes={active} dec={dec} desk={desk} onDone={reloadNotes} />
            </details>
          )}
          {spent.length > 0 && (
            <details>
              <summary className="muted">Spent notes ({spent.length})</summary>
              <NotesTable notes={spent} dec={dec} desk={desk} onDone={reloadNotes} />
            </details>
          )}
        </>
      )}

      <h2>Order book</h2>
      {desk.pairs.length === 0 && <p className="muted">No pairs registered.</p>}
      {desk.pairs.map((p) => (
        <div className="card" key={p.pair_id}>
          <h3>
            {sym(p.base_asset)}/{sym(p.quote_asset)} <span className="muted">· pair {p.pair_id}</span>
          </h3>
          <div className="row">
            <BookView
              desk={desk}
              pairId={p.pair_id}
              side={1}
              label="Asks (sell base)"
              inDecimals={dec(p.base_asset)}
              outDecimals={dec(p.quote_asset)}
              notes={notes}
              onCancel={reloadNotes}
            />
            <BookView
              desk={desk}
              pairId={p.pair_id}
              side={0}
              label="Bids (buy base)"
              inDecimals={dec(p.quote_asset)}
              outDecimals={dec(p.base_asset)}
              notes={notes}
              onCancel={reloadNotes}
            />
          </div>
        </div>
      ))}
    </>
  )
}

/** Last-modified time of a note, falling back to creation for notes saved before updatedAt. */
function mtime(n: Note): number {
  return n.updatedAt ?? n.createdAt
}

/** The note rows for one section (active or spent). Identical layout for both. */
function NotesTable({
  notes,
  dec,
  desk,
  onDone,
}: {
  notes: Note[]
  dec: (id: number) => number
  desk: Desk
  onDone: () => void
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Asset</th>
          <th>Amount</th>
          <th>Owner tag</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {notes.map((n) => (
          <tr key={n.id}>
            <td>{n.symbol}</td>
            <td>{formatAmount(n.amount, dec(n.asset_id))}</td>
            <td className="mono">{n.owner_tag.slice(0, 14)}…</td>
            <td className={n.status === 'spent' ? 'muted' : 'ok'}>{n.status}</td>
            <td>
              {n.cancelledAt ? (
                <span className="muted">cancelled</span>
              ) : (
                n.cancel && <CancelOrderButton desk={desk} note={n} onDone={onDone} />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Spendable shielded balance per asset, summed from confirmed (unspent) notes and formatted
 * to human decimals. `decimals` resolves an asset_id to its decimal places. */
function balances(notes: Note[], decimals: (id: number) => number): [string, string][] {
  const m = new Map<number, { symbol: string; sum: bigint }>()
  for (const n of notes) {
    if (n.status === 'spent') continue
    const e = m.get(n.asset_id) ?? { symbol: n.symbol, sum: 0n }
    e.sum += BigInt(n.amount)
    m.set(n.asset_id, e)
  }
  return [...m.entries()].map(([id, { symbol, sum }]) => [symbol, formatAmount(sum, decimals(id))])
}
