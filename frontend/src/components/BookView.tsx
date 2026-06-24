import { type Desk } from '../api'
import type { BookIndexSnapshot, IndexedOrder } from '../bookIndexer'
import { formatAmount, formatPrice } from '../amount'
import { type Note } from '../notes'
import CancelOrderButton from './CancelOrderButton'

/** Canonical form of a 32-byte hex tag for comparison. The book passes the Soroban CLI's raw
 * `BytesN<32>` rendering (bare lowercase hex, no `0x`), while our local notes store `0x`+64-hex;
 * stripping the prefix and left-padding to 64 makes either representation compare equal. */
function normLeaf(h: string): string {
  return h.replace(/^0x/i, '').toLowerCase().padStart(64, '0')
}

export default function BookView({
  desk,
  label,
  inDecimals,
  outDecimals,
  baseDecimals,
  quoteDecimals,
  inIsBase,
  notes,
  orders,
  bookIndex,
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
  /** Pair base/quote decimals, for the quote-per-base price column. */
  baseDecimals: number
  quoteDecimals: number
  /** Whether the offered (amount_in) asset is the base — true for asks, false for bids. */
  inIsBase: boolean
  /** The user's local notes — used to find orders we placed (and can cancel). */
  notes: Note[]
  orders: IndexedOrder[]
  bookIndex: BookIndexSnapshot
  onCancel: () => void
}) {
  // Our still-cancellable orders, keyed by on-chain order_leaf, so we can offer a cancel button on
  // the matching book row. Only active order-output notes carry usable cancel authority.
  const ownByLeaf = new Map(
    notes
      .filter((n) => n.cancel && n.status === 'active')
      .map((n) => [normLeaf(n.cancel!.order_leaf), n] as const),
  )
  return (
    <div style={{ flex: 1, minWidth: 280 }}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
        {label}
      </div>
      {bookIndex.status === 'error' && <p className="err">Book index unavailable: {bookIndex.error}</p>}
      {bookIndex.status === 'syncing' && (
        <p className="muted">Syncing events · {bookIndex.lastSequence}/{bookIndex.targetSequence}</p>
      )}
      {bookIndex.status === 'synced' && orders.length === 0 && <p className="muted">empty</p>}
      {orders && orders.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>price</th>
              <th>in</th>
              <th>min out</th>
              <th>left</th>
              <th>part</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const own = o.order_leaf ? ownByLeaf.get(normLeaf(o.order_leaf)) : undefined
              // Price is always quote-per-base: amount_in/min_out are base/quote depending on side.
              const baseRaw = BigInt(inIsBase ? o.amount_in : o.min_out)
              const quoteRaw = BigInt(inIsBase ? o.min_out : o.amount_in)
              const px = formatPrice(baseRaw, quoteRaw, baseDecimals, quoteDecimals)
              return (
                <tr key={o.order_id}>
                  <td>{px ?? '—'}</td>
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
