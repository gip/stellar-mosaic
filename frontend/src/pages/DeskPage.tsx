import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, type Desk } from '../api'
import { useWallet } from '../WalletContext'
import BookView from '../components/BookView'
import OrderForm from '../components/OrderForm'
import ShieldUnshieldPanel from '../components/ShieldUnshieldPanel'
import CancelOrderButton from '../components/CancelOrderButton'
import Toasts, { type ToastItem } from '../components/Toasts'
import { notesForDesk, reconcile, type Note } from '../notes'
import { formatAmount } from '../amount'
import { isRecoveryUnlocked, syncRecoveryNow } from '../recovery'
import { ordersFor, type BookIndexSnapshot } from '../bookIndexer'
import { useBookIndex } from '../useBookIndex'
import { setSubmissionMode, submissionMode } from '../directTransaction'

/** Canonical 32-byte hex tag for comparison: drop any `0x`, lowercase, left-pad to 64. */
function normTag(h: string): string {
  return h.replace(/^0x/i, '').toLowerCase().padStart(64, '0')
}

export default function DeskPage() {
  const { deskId } = useParams()
  const { address, networkPassphrase } = useWallet()
  const [desk, setDesk] = useState<Desk | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [error, setError] = useState<string | null>(null)
  const [submitMode, setSubmitMode] = useState<'direct' | 'sponsored'>(submissionMode())
  const bookIndex = useBookIndex(desk, networkPassphrase)

  const reloadNotes = useCallback(() => {
    if (deskId) notesForDesk(deskId, address).then(setNotes)
  }, [deskId, address])

  useEffect(() => {
    if (!deskId) return
    api.getDesk(deskId).then(setDesk).catch((e) => setError(String(e)))
    reloadNotes()
  }, [deskId, reloadNotes])

  useEffect(() => {
    window.addEventListener('mosaic-notes-changed', reloadNotes)
    return () => window.removeEventListener('mosaic-notes-changed', reloadNotes)
  }, [reloadNotes])

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
          if (await reconcile(deskId, r.notes)) {
            if (isRecoveryUnlocked(address ?? undefined)) syncRecoveryNow().catch(() => {})
            reloadNotes()
          }
        })
        .catch(() => {})
    tick()
    const h = setInterval(tick, 7000)
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [deskId, address, reloadNotes])

  // Live confirmation toasts (e.g. "your order filled").
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  // Latest notes, read inside the fills poller without resubscribing it on every notes change.
  const notesRef = useRef<Note[]>(notes)
  useEffect(() => {
    notesRef.current = notes
  }, [notes])

  // Poll `filled` events and toast the ones destined for our own order-output notes. The first poll
  // silently records every existing fill id (so historical fills don't toast); only fills that show
  // up afterwards — i.e. trades that cross during this session — raise a confirmation.
  const seenFills = useRef<Set<string>>(new Set())
  const fillsSeeded = useRef(false)
  useEffect(() => {
    if (!deskId || !desk) return
    const symOf = (id: number) => desk.assets.find((a) => a.asset_id === id)?.symbol ?? `#${id}`
    const decOf = (id: number) => desk.assets.find((a) => a.asset_id === id)?.decimals ?? 7
    let alive = true
    const tick = () =>
      api
        .getFills(deskId)
        .then((r) => {
          if (!alive) return
          const fills = r.fills ?? []
          if (!fillsSeeded.current) {
            fills.forEach((f) => seenFills.current.add(f.id))
            fillsSeeded.current = true
            return
          }
          const mine = new Set(notesRef.current.map((n) => normTag(n.owner_tag)))
          const fresh = fills.filter((f) => !seenFills.current.has(f.id))
          fresh.forEach((f) => seenFills.current.add(f.id))
          const added = fresh
            .filter((f) => mine.has(normTag(f.owner_tag)))
            .map((f) => ({
              id: f.id,
              text: `Order filled — traded ${formatAmount(BigInt(f.amount_in), decOf(f.asset_in))} ${symOf(f.asset_in)} → ${formatAmount(BigInt(f.amount_out), decOf(f.asset_out))} ${symOf(f.asset_out)}`,
            }))
          if (added.length) setToasts((prev) => [...prev, ...added])
        })
        .catch(() => {})
    tick()
    const h = setInterval(tick, 7000)
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [deskId, desk])

  if (error) return <p className="err">{error}</p>
  if (!desk) return <p className="muted">Loading…</p>

  const authoritativeAssets = bookIndex.assets.map((chain) => {
    const display = desk.assets.find((asset) => asset.asset_id === chain.asset_id)
    return {
      asset_id: chain.asset_id,
      token: chain.token,
      symbol: display?.symbol ?? `#${chain.asset_id}`,
      decimals: display?.decimals ?? 7,
    }
  })
  const authoritativePairs = bookIndex.pairs
    .map(({ pair_id, base_asset, quote_asset }) => ({ pair_id, base_asset, quote_asset }))
    .sort((a, b) => a.pair_id - b.pair_id)
  const verifiedDesk: Desk = { ...desk, assets: authoritativeAssets, pairs: authoritativePairs }
  const fundActionsDisabled =
    bookIndex.status === 'synced'
      ? null
      : bookIndex.status === 'error'
        ? `Contract verification failed: ${bookIndex.error ?? 'unknown integrity error'}`
        : bookIndex.error
          ? `Contract verification is retrying: ${bookIndex.error}`
          : 'Contract verification and event replay are still in progress.'
  const displayDesk = bookIndex.status === 'synced' ? verifiedDesk : desk
  const sym = (id: number) => verifiedDesk.assets.find((a) => a.asset_id === id)?.symbol ?? `#${id}`
  const dec = (id: number) => verifiedDesk.assets.find((a) => a.asset_id === id)?.decimals ?? 7

  // Active notes first; spent and cancelled history renders last in its own collapsed section.
  const active = notes.filter((n) => n.status === 'active').sort((a, b) => mtime(b) - mtime(a))
  const history = notes.filter((n) => n.status !== 'active').sort((a, b) => mtime(b) - mtime(a))

  return (
    <>
      <Toasts items={toasts} onDismiss={dismissToast} />
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
          <tr>
            <th>Submission</th>
            <td>
              <select
                value={submitMode}
                onChange={(event) => {
                  const mode = event.target.value as 'direct' | 'sponsored'
                  setSubmissionMode(mode)
                  setSubmitMode(mode)
                }}
              >
                <option value="direct">Self-submit (you pay network fees)</option>
                <option value="sponsored">Desk sponsor</option>
              </select>
            </td>
          </tr>
          <tr>
            <th>Book index</th>
            <td>
              {bookIndex.status} · ledger {bookIndex.lastLedger} · sequence {bookIndex.lastSequence}/
              {bookIndex.targetSequence}
              {bookIndex.error && <div className="err">{bookIndex.error}</div>}
            </td>
          </tr>
          {verifiedDesk.assets.map((a) => (
            <tr key={a.asset_id}>
              <th>
                {a.symbol} (id {a.asset_id})
              </th>
              <td className="mono">{a.token}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ShieldUnshieldPanel
        desk={displayDesk}
        notes={notes}
        userPubkey={address}
        disabledReason={fundActionsDisabled}
        onRecheck={bookIndex.status === 'error' ? bookIndex.recheck : undefined}
        onDone={reloadNotes}
      />

      <h2>Place limit order</h2>
      {address && bookIndex.status === 'synced' ? (
        <OrderForm desk={verifiedDesk} notes={notes} bookIndex={bookIndex} onDone={reloadNotes} />
      ) : (
        <p className="muted">
          {address ? 'Waiting for verified book synchronization.' : 'Connect your wallet to place orders.'}
        </p>
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
              <summary>Active notes ({active.length})</summary>
              <NotesTable
                notes={active}
                dec={dec}
                desk={verifiedDesk}
                bookIndex={bookIndex}
                onDone={reloadNotes}
              />
            </details>
          )}
          {history.length > 0 && (
            <details>
              <summary className="muted">Spent &amp; cancelled notes ({history.length})</summary>
              <NotesTable
                notes={history}
                dec={dec}
                desk={verifiedDesk}
                bookIndex={bookIndex}
                onDone={reloadNotes}
              />
            </details>
          )}
        </>
      )}

      <h2>Order book</h2>
      {verifiedDesk.pairs.length === 0 && bookIndex.status === 'synced' && <p className="muted">No pairs registered.</p>}
      {verifiedDesk.pairs.map((p) => (
        <div className="card" key={p.pair_id}>
          <h3>
            {sym(p.base_asset)}/{sym(p.quote_asset)} <span className="muted">· pair {p.pair_id}</span>
          </h3>
          <div className="row">
            <BookView
              desk={verifiedDesk}
              pairId={p.pair_id}
              side={1}
              label="Asks (sell base)"
              inDecimals={dec(p.base_asset)}
              outDecimals={dec(p.quote_asset)}
              baseDecimals={dec(p.base_asset)}
              quoteDecimals={dec(p.quote_asset)}
              inIsBase={true}
              notes={notes}
              orders={ordersFor(bookIndex, p.pair_id, 1)}
              bookIndex={bookIndex}
              onCancel={reloadNotes}
            />
            <BookView
              desk={verifiedDesk}
              pairId={p.pair_id}
              side={0}
              label="Bids (buy base)"
              inDecimals={dec(p.quote_asset)}
              outDecimals={dec(p.base_asset)}
              baseDecimals={dec(p.base_asset)}
              quoteDecimals={dec(p.quote_asset)}
              inIsBase={false}
              notes={notes}
              orders={ordersFor(bookIndex, p.pair_id, 0)}
              bookIndex={bookIndex}
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
  bookIndex,
  onDone,
}: {
  notes: Note[]
  dec: (id: number) => number
  desk: Desk
  bookIndex: BookIndexSnapshot
  onDone: () => void
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Type</th>
          <th>Pair</th>
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
            <td>{noteType(n)}</td>
            <td>{notePair(n, desk)}</td>
            <td>{n.symbol}</td>
            <td>{formatAmount(n.amount, dec(n.asset_id))}</td>
            <td className="mono">{n.owner_tag.slice(0, 14)}…</td>
            <td className={n.status === 'active' ? 'ok' : 'muted'}>
              {noteDisplayStatus(n, bookIndex)}
            </td>
            <td>
              {n.status === 'active' && n.cancel && (
                <CancelOrderButton desk={desk} note={n} onDone={onDone} />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function noteDisplayStatus(n: Note, bookIndex: BookIndexSnapshot): string {
  if (n.status !== 'active' || n.indexed) return n.status
  if (!n.cancel) return 'active · pending index'
  if (bookIndex.status !== 'synced') return 'order submitted · syncing book'
  const resting = bookIndex.orders.some(
    (order) => normTag(order.order_leaf) === normTag(n.cancel!.order_leaf),
  )
  return resting ? 'resting · awaiting fill' : 'active · pending proceeds'
}

/** User-facing note kind. Order notes retain the side used when they were submitted. */
function noteType(n: Note): 'Asset' | 'Buy' | 'Sell' {
  if (n.role === 'asset') return 'Asset'
  return n.cancel?.side === 0 ? 'Buy' : 'Sell'
}

/** Canonical base/quote symbols for order notes; asset notes have no associated pair. */
function notePair(n: Note, desk: Desk): string {
  if (!n.cancel) return '—'
  const pair = desk.pairs.find((p) => p.pair_id === n.cancel?.pairId)
  if (!pair) return `Pair ${n.cancel.pairId}`
  const symbol = (assetId: number) =>
    desk.assets.find((asset) => asset.asset_id === assetId)?.symbol ?? `#${assetId}`
  return `${symbol(pair.base_asset)}/${symbol(pair.quote_asset)}`
}

/** Spendable shielded balance per asset, summed from indexed active notes and formatted
 * to human decimals. `decimals` resolves an asset_id to its decimal places. */
function balances(notes: Note[], decimals: (id: number) => number): [string, string][] {
  const m = new Map<number, { symbol: string; sum: bigint }>()
  for (const n of notes) {
    if (n.status !== 'active' || !n.indexed) continue
    const e = m.get(n.asset_id) ?? { symbol: n.symbol, sum: 0n }
    e.sum += BigInt(n.amount)
    m.set(n.asset_id, e)
  }
  return [...m.entries()].map(([id, { symbol, sum }]) => [symbol, formatAmount(sum, decimals(id))])
}
