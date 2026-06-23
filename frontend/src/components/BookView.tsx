import { useEffect, useState } from 'react'
import { api, type Desk } from '../api'
import { formatAmount, formatPrice } from '../amount'
import { type Note } from '../notes'
import CancelOrderButton from './CancelOrderButton'

interface OrderEntry {
  asset_in: number
  asset_out: number
  amount_in: string | number
  min_out: string | number
  expiry: string | number
  partial_allowed: boolean
  order_leaf: string
  active: boolean
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
  baseDecimals,
  quoteDecimals,
  inIsBase,
  notes,
  onCancel,
}: {
  desk: Desk
  pairId: number
  side: number
  label: string
  /** Decimals of the asset offered (amount_in). */
  inDecimals: number
  /** Decimals of the asset requested (min_out). */
  outDecimals: number
  /** Pair base/quote decimals, for the quote-per-base price column. */
  baseDecimals: number
  quoteDecimals: number
  /** Whether the offered (amount_in) asset is the base — true for asks, false for bids. */
  inIsBase: boolean
  /** The user's local notes — used to find orders we placed (and can cancel). */
  notes: Note[]
  onCancel: () => void
}) {
  const deskId = desk.id
  // Our still-cancellable orders, keyed by on-chain order_leaf, so we can offer a cancel button on
  // the matching book row. Only active order-output notes carry usable cancel authority.
  const ownByLeaf = new Map(
    notes
      .filter((n) => n.cancel && n.status === 'active')
      .map((n) => [normLeaf(n.cancel!.order_leaf), n] as const),
  )
  // This side's asset orientation, used to filter the (pair-agnostic) event-derived book.
  const pair = desk.pairs.find((p) => p.pair_id === pairId)
  const myAssetIn = pair ? (inIsBase ? pair.base_asset : pair.quote_asset) : -1
  const myAssetOut = pair ? (inIsBase ? pair.quote_asset : pair.base_asset) : -1

  const [orders, setOrders] = useState<OrderEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const tick = () =>
      api
        .getBook(deskId)
        .then((r) => {
          if (!alive) return
          // Event-derived book is pair-agnostic; keep only active orders on this side.
          const mine = ((r.orders as OrderEntry[]) ?? []).filter(
            (o) => o.active && o.asset_in === myAssetIn && o.asset_out === myAssetOut,
          )
          setOrders(mine)
          setError(null)
        })
        .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    tick()
    const h = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [deskId, myAssetIn, myAssetOut])

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
              <th>price</th>
              <th>in</th>
              <th>min out</th>
              <th>part</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o, i) => {
              const own = o.order_leaf ? ownByLeaf.get(normLeaf(o.order_leaf)) : undefined
              // Price is always quote-per-base: amount_in/min_out are base/quote depending on side.
              const baseRaw = BigInt(inIsBase ? o.amount_in : o.min_out)
              const quoteRaw = BigInt(inIsBase ? o.min_out : o.amount_in)
              const px = formatPrice(baseRaw, quoteRaw, baseDecimals, quoteDecimals)
              return (
                <tr key={o.order_leaf ?? i}>
                  <td>{px ?? '—'}</td>
                  <td>{formatAmount(BigInt(o.amount_in), inDecimals)}</td>
                  <td>{formatAmount(BigInt(o.min_out), outDecimals)}</td>
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
