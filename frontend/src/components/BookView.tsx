import { useEffect, useState } from 'react'
import { api } from '../api'
import { formatAmount } from '../amount'

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
  inDecimals,
  outDecimals,
}: {
  deskId: string
  pairId: number
  side: number
  label: string
  /** Decimals of the asset offered (amount_in / remaining_in). */
  inDecimals: number
  /** Decimals of the asset requested (min_out). */
  outDecimals: number
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
                <td>{formatAmount(BigInt(o.amount_in), inDecimals)}</td>
                <td>{formatAmount(BigInt(o.min_out), outDecimals)}</td>
                <td>{formatAmount(BigInt(o.remaining_in), inDecimals)}</td>
                <td>{o.partial_allowed ? 'Y' : 'N'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
