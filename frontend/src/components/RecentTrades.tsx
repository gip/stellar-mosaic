import { formatAmount, formatPrice } from '@mosaic/sdk'
import type { Desk, Fill } from '../api'
import { stellarExpertTxUrl } from '../explorer'
import ScrollTable from './ui/ScrollTable'

/** Desk-wide trade tape rebuilt from the contract's public `filled` events. Amounts/prices are public
 * by design (Stellar Mosaic is amount-transparent); only owner identity is hidden, so this is shown to
 * every visitor including logged-out/public. The parent supplies the enclosing `Pane`. */
export default function RecentTrades({
  desk,
  fills,
  sym,
  dec,
}: {
  desk: Desk
  fills: Fill[]
  sym: (id: number) => string
  dec: (id: number) => number
}) {
  if (fills.length === 0) return <p className="muted">No trades yet.</p>

  // Newest first; `ledger` is monotonic, `id` breaks ties within a ledger for a stable order.
  const rows = [...fills].sort((a, b) => b.ledger - a.ledger || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))

  return (
    <ScrollTable>
      <table>
        <thead>
          <tr>
            <th>Ledger</th>
            <th>Trade</th>
            <th>Side</th>
            <th className="num">Price</th>
            <th>Tx</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => {
            const { side, price } = sideAndPrice(f, desk, dec)
            return (
              <tr key={f.id}>
                <td className="num">{f.ledger}</td>
                <td>
                  {formatAmount(BigInt(f.amount_in), dec(f.asset_in))} {sym(f.asset_in)} →{' '}
                  {formatAmount(BigInt(f.amount_out), dec(f.asset_out))} {sym(f.asset_out)}
                </td>
                <td>{side ?? <span className="muted">—</span>}</td>
                <td className="num">{price ?? <span className="muted">—</span>}</td>
                <td>
                  {f.tx_hash ? (
                    <a
                      className="mono"
                      href={stellarExpertTxUrl(f.tx_hash)}
                      target="_blank"
                      rel="noreferrer"
                      title={`View ${f.tx_hash} on Stellar Expert`}
                    >
                      {f.tx_hash.slice(0, 8)}…
                    </a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </ScrollTable>
  )
}

/** Classify a taker fill against the desk's canonical pairs. SELL = gave base / got quote; BUY = gave
 * quote / got base. Price is quote-per-base. Returns nulls when the fill's asset pair isn't a
 * registered pair (e.g. an atomic-settle combo the order book never produces). */
function sideAndPrice(
  f: Fill,
  desk: Desk,
  dec: (id: number) => number,
): { side: 'Buy' | 'Sell' | null; price: string | null } {
  for (const pair of desk.pairs) {
    if (f.asset_in === pair.base_asset && f.asset_out === pair.quote_asset) {
      return {
        side: 'Sell',
        price: formatPrice(BigInt(f.amount_in), BigInt(f.amount_out), dec(pair.base_asset), dec(pair.quote_asset)),
      }
    }
    if (f.asset_in === pair.quote_asset && f.asset_out === pair.base_asset) {
      return {
        side: 'Buy',
        price: formatPrice(BigInt(f.amount_out), BigInt(f.amount_in), dec(pair.base_asset), dec(pair.quote_asset)),
      }
    }
  }
  return { side: null, price: null }
}
