import { useEffect, useState } from 'react'
import { api } from '../api'

interface OrderEntry {
  amount_in: string | number
  min_out: string | number
  remaining_in: string | number
  expiry: string | number
  partial_allowed: boolean
  order_leaf?: string
}

export default function BookView({
  deskId,
  pairId,
  side,
  label,
}: {
  deskId: string
  pairId: number
  side: number
  label: string
}) {
  const [orders, setOrders] = useState<OrderEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const tick = () =>
      api
        .getBook(deskId, pairId, side)
        .then((r) => {
          if (!alive) return
          setOrders((r.orders as OrderEntry[]) ?? [])
          setError(null)
        })
        .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    tick()
    const h = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [deskId, pairId, side])

  return (
    <div style={{ flex: 1, minWidth: 280 }}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
        {label}
      </div>
      {error && <p className="err">{error}</p>}
      {!error && orders === null && <p className="muted">…</p>}
      {orders?.length === 0 && <p className="muted">empty</p>}
      {orders && orders.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>in</th>
              <th>min out</th>
              <th>left</th>
              <th>part</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o, i) => (
              <tr key={o.order_leaf ?? i}>
                <td>{String(o.amount_in)}</td>
                <td>{String(o.min_out)}</td>
                <td>{String(o.remaining_in)}</td>
                <td>{o.partial_allowed ? 'Y' : 'N'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
