import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, type Desk } from '../api'
import { useWallet } from '../WalletContext'
import BookView from '../components/BookView'

export default function DeskPage() {
  const { deskId } = useParams()
  const { address } = useWallet()
  const [desk, setDesk] = useState<Desk | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!deskId) return
    api.getDesk(deskId).then(setDesk).catch((e) => setError(String(e)))
  }, [deskId])

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

      <h2>Address book — my notes</h2>
      {address ? (
        <p className="muted">No notes yet. Shielding lands in a later phase.</p>
      ) : (
        <p className="muted">Connect your wallet to see your notes.</p>
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
