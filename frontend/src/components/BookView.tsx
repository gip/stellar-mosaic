import { useMemo } from 'react'
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

/** base/quote raw amounts for an order. Price is always quote-per-base; which of amount_in/min_out
 * is the base depends on the side (offered asset is base for asks, quote for bids). */
function baseQuote(o: IndexedOrder, inIsBase: boolean): [bigint, bigint] {
  const base = BigInt(inIsBase ? o.amount_in : o.min_out)
  const quote = BigInt(inIsBase ? o.min_out : o.amount_in)
  return [base, quote]
}

/** One side of the book (asks or bids) rendered as a depth ladder, highest price on top so the
 * best price sits adjacent to the spread. Depth bars scale by `remaining_in` within the side. */
export default function BookView({
  desk,
  tone,
  showHeader = true,
  inDecimals,
  outDecimals,
  baseDecimals,
  quoteDecimals,
  inIsBase,
  notes,
  orders,
  bookIndex,
  userPubkey,
  trustless = false,
  onCancel,
}: {
  desk: Desk
  pairId: number
  side: number
  /** Visual + semantic side: asks show in sell-red, bids in buy-green. */
  tone: 'ask' | 'bid'
  showHeader?: boolean
  inDecimals: number
  outDecimals: number
  baseDecimals: number
  quoteDecimals: number
  inIsBase: boolean
  notes: Note[]
  orders: IndexedOrder[]
  bookIndex: BookIndexSnapshot
  userPubkey: string
  trustless?: boolean
  onCancel: () => void
}) {
  // Our still-cancellable orders, keyed by on-chain order_leaf, so we can offer a cancel button on
  // the matching book row. Only active order-output notes carry usable cancel authority.
  const ownByLeaf = useMemo(
    () =>
      new Map(
        notes
          .filter((n) => n.cancel && n.status === 'active')
          .map((n) => [normLeaf(n.cancel!.order_leaf), n] as const),
      ),
    [notes],
  )

  // Sort by price descending (best price nearest the spread) and scale depth by max remaining.
  const rows = useMemo(() => {
    const withRaw = orders.map((o) => ({ o, bq: baseQuote(o, inIsBase) }))
    withRaw.sort((a, b) => {
      const [ab, aq] = a.bq
      const [bb, bq] = b.bq
      // price_a vs price_b == aq/ab vs bq/bb == aq*bb vs bq*ab (descending)
      const lhs = aq * bb
      const rhs = bq * ab
      return lhs < rhs ? 1 : lhs > rhs ? -1 : 0
    })
    const maxRemaining = withRaw.reduce((m, { o }) => {
      const r = BigInt(o.remaining_in)
      return r > m ? r : m
    }, 1n)
    return withRaw.map(({ o, bq }) => ({
      o,
      px: formatPrice(bq[0], bq[1], baseDecimals, quoteDecimals),
      depth: Number((BigInt(o.remaining_in) * 100n) / maxRemaining),
    }))
  }, [orders, inIsBase, baseDecimals, quoteDecimals])

  if (bookIndex.status === 'error') return <p className="err">Book index unavailable: {bookIndex.error}</p>
  if (bookIndex.status === 'syncing')
    return (
      <p className="muted">
        Syncing events · {bookIndex.lastSequence}/{bookIndex.targetSequence}
      </p>
    )
  if (rows.length === 0) return <p className="muted">No {tone === 'ask' ? 'asks' : 'bids'}.</p>

  return (
    <table className="book-table">
      {showHeader && (
        <thead>
          <tr>
            <th>Price</th>
            <th>In</th>
            <th>Min out</th>
            <th>Left</th>
            <th>Part</th>
            <th />
          </tr>
        </thead>
      )}
      <tbody>
        {rows.map(({ o, px, depth }) => {
          const own = o.order_leaf ? ownByLeaf.get(normLeaf(o.order_leaf)) : undefined
          return (
            <tr key={o.order_id} className={`book-row ${tone}${own ? ' own' : ''}`}>
              <td>
                <span className="depth-bar" style={{ width: `${depth}%` }} />
                <span className={`book-px ${tone}`}>{px ?? '—'}</span>
              </td>
              <td>{formatAmount(BigInt(o.amount_in), inDecimals)}</td>
              <td>{formatAmount(BigInt(o.min_out), outDecimals)}</td>
              <td>{formatAmount(BigInt(o.remaining_in), inDecimals)}</td>
              <td>{o.partial_allowed ? 'Y' : 'N'}</td>
              <td>
                {own && userPubkey && (
                  <CancelOrderButton
                    desk={desk}
                    note={own}
                    userPubkey={userPubkey}
                    trustless={trustless}
                    onDone={onCancel}
                  />
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
