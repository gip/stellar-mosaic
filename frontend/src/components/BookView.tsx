import { useEffect, useState } from 'react'
import { api, type Desk } from '../api'
import { formatAmount } from '../amount'
import { type Note } from '../notes'
import CancelOrderButton from './CancelOrderButton'

interface OrderEntry {
  amount_in: string | number
  min_out: string | number
  remaining_in: string | number
  expiry: string | number
  partial_allowed: boolean
  order_leaf?: string
}

/** Canonical form of a 32-byte hex tag for comparison. The book passes the Soroban CLI's raw
 * `BytesN<32>` rendering (bare lowercase hex, no `0x`), while our local notes store `0x`+64-hex;
 * stripping the prefix and left-padding to 64 makes either representation compare equal. */
function normLeaf(h: string): string {
  return h.replace(/^0x/i, '').toLowerCase().padStart(64, '0')
}

export default function BookView({
  desk,
  pairId,
  side,
  label,
  inDecimals,
  outDecimals,
  notes,
  onCancel,
}: {
  desk: Desk
  pairId: number
  side: number
  label: string
  /** Decimals of the asset offered (amount_in / remaining_in). */
  inDecimals: number
  /** Decimals of the asset requested (min_out). */
  outDecimals: number
  /** The user's local notes — used to find orders we placed (and can cancel). */
  notes: Note[]
  onCancel: () => void
}) {
  const deskId = desk.id
  // Our still-cancellable orders, keyed by on-chain order_leaf, so we can offer a cancel button on
  // the matching book row. Only order-output notes carry cancel authority; cancelled ones are gone.
  const ownByLeaf = new Map(
    notes
      .filter((n) => n.cancel && !n.cancelledAt)
      .map((n) => [normLeaf(n.cancel!.order_leaf), n] as const),
  )
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
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o, i) => {
              const own = o.order_leaf ? ownByLeaf.get(normLeaf(o.order_leaf)) : undefined
              return (
                <tr key={o.order_leaf ?? i}>
                  <td>{formatAmount(BigInt(o.amount_in), inDecimals)}</td>
                  <td>{formatAmount(BigInt(o.min_out), outDecimals)}</td>
                  <td>{formatAmount(BigInt(o.remaining_in), inDecimals)}</td>
                  <td>{o.partial_allowed ? 'Y' : 'N'}</td>
                  <td>
                    {own && <CancelOrderButton desk={desk} note={own} onDone={onCancel} />}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
