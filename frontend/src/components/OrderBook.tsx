import { useMemo } from 'react'
import { type Desk } from '../api'
import type { BookIndexSnapshot, IndexedOrder } from '../bookIndexer'
import { type Note } from '../notes'
import BookView from './BookView'

type Pair = { pair_id: number; base_asset: number; quote_asset: number }

/** Human quote-per-base price of an order, for spread/mid display only. */
function priceNum(o: IndexedOrder, inIsBase: boolean, baseDec: number, quoteDec: number): number {
  const base = Number(BigInt(inIsBase ? o.amount_in : o.min_out))
  const quote = Number(BigInt(inIsBase ? o.min_out : o.amount_in))
  if (base === 0) return NaN
  return (quote / base) * 10 ** (baseDec - quoteDec)
}

function fmt(n: number): string {
  if (!isFinite(n)) return '—'
  return n.toLocaleString(undefined, { maximumSignificantDigits: 6 })
}

/** Full order book for one pair: asks on top, a spread/mid row, then bids — each side a depth
 * ladder. Best prices sit adjacent to the spread. */
export default function OrderBook({
  desk,
  pair,
  sym,
  dec,
  asks,
  bids,
  bookIndex,
  notes,
  userPubkey,
  trustless,
  onCancel,
}: {
  desk: Desk
  pair: Pair
  sym: (id: number) => string
  dec: (id: number) => number
  asks: IndexedOrder[]
  bids: IndexedOrder[]
  bookIndex: BookIndexSnapshot
  notes: Note[]
  userPubkey: string
  trustless: boolean
  onCancel: () => void
}) {
  const baseDec = dec(pair.base_asset)
  const quoteDec = dec(pair.quote_asset)

  const { bestAsk, bestBid } = useMemo(() => {
    const askPrices = asks.map((o) => priceNum(o, true, baseDec, quoteDec)).filter(isFinite)
    const bidPrices = bids.map((o) => priceNum(o, false, baseDec, quoteDec)).filter(isFinite)
    return {
      bestAsk: askPrices.length ? Math.min(...askPrices) : NaN,
      bestBid: bidPrices.length ? Math.max(...bidPrices) : NaN,
    }
  }, [asks, bids, baseDec, quoteDec])

  const hasSpread = isFinite(bestAsk) && isFinite(bestBid)
  const spread = hasSpread ? bestAsk - bestBid : NaN
  const mid = hasSpread ? (bestAsk + bestBid) / 2 : NaN
  const spreadPct = hasSpread && mid > 0 ? (spread / mid) * 100 : NaN

  const quoteSym = sym(pair.quote_asset)

  return (
    <div className="book">
      <BookView
        desk={desk}
        pairId={pair.pair_id}
        side={1}
        tone="ask"
        showHeader
        inDecimals={baseDec}
        outDecimals={quoteDec}
        baseDecimals={baseDec}
        quoteDecimals={quoteDec}
        inIsBase
        notes={notes}
        orders={asks}
        bookIndex={bookIndex}
        userPubkey={userPubkey}
        trustless={trustless}
        onCancel={onCancel}
      />
      <div className="book-spread">
        {hasSpread ? (
          <>
            <span>
              Mid <span className="px">{fmt(mid)}</span> {quoteSym}
            </span>
            <span>
              Spread <span className="px">{fmt(spread)}</span>
              {isFinite(spreadPct) && <span className="dim"> ({spreadPct.toFixed(2)}%)</span>}
            </span>
          </>
        ) : (
          <span className="dim">No two-sided market</span>
        )}
      </div>
      <BookView
        desk={desk}
        pairId={pair.pair_id}
        side={0}
        tone="bid"
        showHeader={false}
        inDecimals={quoteDec}
        outDecimals={baseDec}
        baseDecimals={baseDec}
        quoteDecimals={quoteDec}
        inIsBase={false}
        notes={notes}
        orders={bids}
        bookIndex={bookIndex}
        userPubkey={userPubkey}
        trustless={trustless}
        onCancel={onCancel}
      />
    </div>
  )
}
