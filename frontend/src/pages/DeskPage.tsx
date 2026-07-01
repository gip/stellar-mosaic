import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { errorMessage } from '@mosaic/sdk'
import { api, type Asset, type Desk } from '../api'
import { NATIVE_EVM_SENTINEL } from '../baseDeployment'
import { useWallet } from '../WalletContext'
import OrderBook from '../components/OrderBook'
import OrderForm from '../components/OrderForm'
import ShieldUnshieldPanel from '../components/ShieldUnshieldPanel'
import CancelOrderButton from '../components/CancelOrderButton'
import Pane from '../components/ui/Pane'
import Tabs from '../components/ui/Tabs'
import StatusDot, { type StatusTone } from '../components/ui/StatusDot'
import ScrollTable from '../components/ui/ScrollTable'
import Toasts, { type ToastItem } from '../components/Toasts'
import { notesForDesk, reconcile, type Note } from '../notes'
import { formatAmount } from '../amount'
import { isRecoveryUnlocked, syncRecoveryNow } from '../recovery'
import { ordersFor, type BookIndexSnapshot } from '../bookIndexer'
import { useBookIndex } from '../useBookIndex'
import { setSubmissionMode, submissionMode } from '../directTransaction'
import { useStorageMode } from '../StorageModeContext'

/** Canonical 32-byte hex tag for comparison: drop any `0x`, lowercase, left-pad to 64. */
function normTag(h: string): string {
  return h.replace(/^0x/i, '').toLowerCase().padStart(64, '0')
}

/** Token address cell for an asset, kind-aware. `Stellar`/`Dual` show the real Soroban SAC. A
 * `BaseRepresented` asset has no Stellar token (the on-chain `assetreg` event carries the contract's
 * own address as a placeholder), so show its Base token from the Base deployment instead. */
function assetTokenCell(a: Asset, desk: Desk) {
  if (a.kind !== 'BaseRepresented') return a.token
  const base = desk.base_deployment?.assets.find((m) => m.asset_id === a.asset_id)
  // Native ETH has no ERC-20 contract; the Base side registers under the NATIVE sentinel, which is
  // not a real address — show "Represented" rather than the meaningless 0xEeee… string.
  if (base && base.token.toLowerCase() === NATIVE_EVM_SENTINEL.toLowerCase()) {
    return <span className="muted">Represented (native ETH)</span>
  }
  if (base) return `${base.token} (Base)`
  return <span className="muted">Represented — no Stellar token</span>
}

function sameDeskProjection(a: Desk | null, b: Desk): boolean {
  if (!a || a.id !== b.id || a.assets.length !== b.assets.length || a.pairs.length !== b.pairs.length) {
    return false
  }
  return (
    a.assets.every((asset, i) => {
      const other = b.assets[i]
      return (
        asset.asset_id === other.asset_id &&
        asset.token === other.token &&
        asset.symbol === other.symbol &&
        asset.decimals === other.decimals &&
        asset.kind === other.kind
      )
    }) &&
    a.pairs.every((pair, i) => {
      const other = b.pairs[i]
      return (
        pair.pair_id === other.pair_id &&
        pair.base_asset === other.base_asset &&
        pair.quote_asset === other.quote_asset
      )
    })
  )
}

export default function DeskPage() {
  const { deskId } = useParams()
  const { address, networkPassphrase } = useWallet()
  const storageMode = useStorageMode()
  const [desk, setDesk] = useState<Desk | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const trustlessDesk = storageMode.mode === 'trustless'
  const [error, setError] = useState<string | null>(null)
  const [noteIndexError, setNoteIndexError] = useState<string | null>(null)
  const [submitMode, setSubmitMode] = useState<'direct' | 'sponsored'>(submissionMode())
  const [lastVerifiedDesk, setLastVerifiedDesk] = useState<Desk | null>(null)
  const [activePairId, setActivePairId] = useState<number | null>(null)
  const [tradeTab, setTradeTab] = useState<'trade' | 'fund'>('trade')
  const bookIndex = useBookIndex(storageMode.mode, desk, networkPassphrase)

  const currentVerifiedDesk = useMemo<Desk | null>(() => {
    if (!desk || bookIndex.status !== 'synced') return null
    const authoritativeAssets = bookIndex.assets.map((chain) => {
      const display = desk.assets.find((asset) => asset.asset_id === chain.asset_id)
      return {
        asset_id: chain.asset_id,
        token: chain.token,
        symbol: display?.symbol ?? `#${chain.asset_id}`,
        decimals: display?.decimals ?? 7,
        kind: chain.kind, // authoritative: the on-chain AssetKind from the assetreg event
      }
    })
    const authoritativePairs = bookIndex.pairs
      .map(({ pair_id, base_asset, quote_asset }) => ({ pair_id, base_asset, quote_asset }))
      .sort((a, b) => a.pair_id - b.pair_id)
    return { ...desk, assets: authoritativeAssets, pairs: authoritativePairs }
  }, [desk, bookIndex.status, bookIndex.assets, bookIndex.pairs])

  useEffect(() => {
    if (!currentVerifiedDesk) return
    queueMicrotask(() => {
      setLastVerifiedDesk((prev) => (sameDeskProjection(prev, currentVerifiedDesk) ? prev : currentVerifiedDesk))
    })
  }, [currentVerifiedDesk])

  const reloadNotes = useCallback(() => {
    if (deskId) notesForDesk(storageMode.mode, deskId, address).then(setNotes)
  }, [storageMode.mode, deskId, address])

  useEffect(() => {
    if (!deskId) return
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setDesk(null)
      setRoot(null)
      setNotes([])
      setError(null)
      setNoteIndexError(null)
      setLastVerifiedDesk(null)
    })
    Promise.all([api.getDesk(storageMode.mode, deskId)])
      .then(([nextDesk]) => {
        if (!active) return
        setDesk(nextDesk)
      })
      .catch((e) => active && setError(errorMessage(e)))
    reloadNotes()
    return () => { active = false }
  }, [storageMode.mode, deskId, reloadNotes])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ mode?: string }>).detail
      if (!detail?.mode || detail.mode === storageMode.mode) reloadNotes()
    }
    window.addEventListener('mosaic-notes-changed', handler)
    return () => window.removeEventListener('mosaic-notes-changed', handler)
  }, [storageMode.mode, reloadNotes])

  // Auto-refresh the on-chain root every 5s as a liveness signal.
  useEffect(() => {
    if (!deskId) return
    let alive = true
    const tick = () =>
      api
        .getRoot(storageMode.mode, deskId)
        .then((r) => alive && setRoot(r.root))
        .catch(() => {})
    tick()
    const h = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [storageMode.mode, deskId])

  // Reconcile local notes against on-chain state every 7s so filled proceeds appear.
  useEffect(() => {
    if (!deskId) return
    let alive = true
    const tick = () =>
      api
        .getNotes(storageMode.mode, deskId)
        .then(async (r) => {
          if (!alive) return
          setNoteIndexError(null)
          if (await reconcile(storageMode.mode, deskId, r.notes)) {
            if (isRecoveryUnlocked(address ?? undefined)) syncRecoveryNow().catch(() => {})
            reloadNotes()
          }
        })
        .catch((e) => {
          if (alive) setNoteIndexError(errorMessage(e))
        })
    tick()
    const h = setInterval(tick, 7000)
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [storageMode.mode, deskId, address, reloadNotes])

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
    seenFills.current = new Set()
    fillsSeeded.current = false
    const symOf = (id: number) => desk.assets.find((a) => a.asset_id === id)?.symbol ?? `#${id}`
    const decOf = (id: number) => desk.assets.find((a) => a.asset_id === id)?.decimals ?? 7
    let alive = true
    const tick = () =>
      api
        .getFills(storageMode.mode, deskId)
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
  }, [storageMode.mode, deskId, desk])

  if (error) return <p className="err">{error}</p>
  if (!desk) return <p className="muted">Loading…</p>

  const verifiedDesk = currentVerifiedDesk ?? lastVerifiedDesk ?? desk
  const fundActionsDisabled =
    bookIndex.status === 'synced'
      ? null
      : bookIndex.status === 'error'
        ? `Contract verification failed: ${bookIndex.error ?? 'unknown integrity error'}`
        : bookIndex.error
          ? `Contract verification is retrying: ${bookIndex.error}`
          : 'Contract verification and event replay are still in progress.'
  const displayDesk = currentVerifiedDesk ?? desk
  const orderDesk = currentVerifiedDesk ?? lastVerifiedDesk ?? desk
  const orderDisabledReason =
    address && orderDesk && bookIndex.status !== 'synced'
      ? (fundActionsDisabled ?? 'Waiting for verified book synchronization.')
      : null
  const sym = (id: number) => verifiedDesk.assets.find((a) => a.asset_id === id)?.symbol ?? `#${id}`
  const dec = (id: number) => verifiedDesk.assets.find((a) => a.asset_id === id)?.decimals ?? 7

  // Active notes first; spent and cancelled history renders last in its own collapsed section.
  const active = notes.filter((n) => n.status === 'active').sort((a, b) => mtime(b) - mtime(a))
  const history = notes.filter((n) => n.status !== 'active').sort((a, b) => mtime(b) - mtime(a))

  const pairs = verifiedDesk.pairs
  const selectedPair = pairs.find((p) => p.pair_id === activePairId) ?? pairs[0] ?? null
  const bookTone: StatusTone =
    bookIndex.status === 'synced' ? 'ok' : bookIndex.status === 'error' ? 'err' : 'busy'

  return (
    <>
      <Toasts items={toasts} onDismiss={dismissToast} />
      <div className="desk-head">
        <h1 className="desk-title">{desk.name}</h1>
        <StatusDot tone={bookTone} title={bookIndex.error ?? undefined}>
          Book {bookIndex.status} · seq {bookIndex.lastSequence}/{bookIndex.targetSequence}
        </StatusDot>
      </div>

      <div className="desk-grid">
        {/* Left rail — balances, notes, desk config */}
        <div className="stack">
          <Pane title="Shielded balances">
            {balances(notes, dec).length > 0 ? (
              <div className="balances">
                {balances(notes, dec).map(([s, amt]) => (
                  <span className="pill accent" key={s}>
                    {s} {amt}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted">No shielded balance yet.</p>
            )}
          </Pane>

          <Pane title="My notes">
            {notes.length === 0 ? (
              <p className="muted">No notes yet.</p>
            ) : (
              <>
                {active.length > 0 && (
                  <details open>
                    <summary>Active notes ({active.length})</summary>
                    <ScrollTable>
                      <NotesTable
                        notes={active}
                        dec={dec}
                        desk={verifiedDesk}
                        bookIndex={bookIndex}
                        noteIndexError={noteIndexError}
                        userPubkey={address ?? ''}
                        trustless={trustlessDesk}
                        onDone={reloadNotes}
                      />
                    </ScrollTable>
                  </details>
                )}
                {history.length > 0 && (
                  <details>
                    <summary className="muted">Spent &amp; cancelled ({history.length})</summary>
                    <ScrollTable>
                      <NotesTable
                        notes={history}
                        dec={dec}
                        desk={verifiedDesk}
                        bookIndex={bookIndex}
                        noteIndexError={noteIndexError}
                        userPubkey={address ?? ''}
                        trustless={trustlessDesk}
                        onDone={reloadNotes}
                      />
                    </ScrollTable>
                  </details>
                )}
              </>
            )}
          </Pane>

          <Pane title="Desk details">
            <details>
              <summary className="muted">Addresses &amp; config</summary>
              <ScrollTable>
                <table>
                  <tbody>
                    <tr>
                      <th>Stellar contract</th>
                      <td className="mono">{desk.contract_id}</td>
                    </tr>
                    <tr>
                      <th>Base bridge</th>
                      <td className="mono">
                        {desk.base_deployment?.bridge_address ? (
                          desk.base_deployment.bridge_address
                        ) : (
                          <span className="muted">
                            {desk.base_deployment
                              ? `not deployed (${desk.base_deployment.status})`
                              : 'not deployed'}
                          </span>
                        )}
                      </td>
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
                        {trustlessDesk ? (
                          <span>Self-submit (you pay network fees)</span>
                        ) : (
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
                        )}
                      </td>
                    </tr>
                    <tr>
                      <th>Book index</th>
                      <td>
                        {bookIndex.status} · ledger {bookIndex.lastLedger} · sequence{' '}
                        {bookIndex.lastSequence}/{bookIndex.targetSequence}
                        {bookIndex.error && <div className="err">{bookIndex.error}</div>}
                      </td>
                    </tr>
                    {verifiedDesk.assets.map((a) => (
                      <tr key={a.asset_id}>
                        <th>
                          {a.symbol} (id {a.asset_id})
                        </th>
                        <td className="mono">{assetTokenCell(a, desk)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollTable>
            </details>
          </Pane>
        </div>

        {/* Center — order book */}
        <Pane title="Order book">
          {pairs.length === 0 ? (
            <p className="muted">
              {bookIndex.status === 'synced'
                ? 'No pairs registered.'
                : 'Waiting for verified book synchronization.'}
            </p>
          ) : (
            <>
              {pairs.length > 1 && (
                <Tabs
                  ariaLabel="Trading pair"
                  value={String(selectedPair?.pair_id)}
                  onChange={(id) => setActivePairId(Number(id))}
                  tabs={pairs.map((p) => ({
                    id: String(p.pair_id),
                    label: `${sym(p.base_asset)}/${sym(p.quote_asset)}`,
                  }))}
                />
              )}
              {selectedPair && (
                <OrderBook
                  desk={verifiedDesk}
                  pair={selectedPair}
                  sym={sym}
                  dec={dec}
                  asks={ordersFor(bookIndex, selectedPair.pair_id, 1)}
                  bids={ordersFor(bookIndex, selectedPair.pair_id, 0)}
                  bookIndex={bookIndex}
                  notes={notes}
                  userPubkey={address ?? ''}
                  trustless={trustlessDesk}
                  onCancel={reloadNotes}
                />
              )}
            </>
          )}
        </Pane>

        {/* Right rail — trade + fund */}
        <div className="stack">
          <Pane>
            <Tabs
              ariaLabel="Trade or fund"
              value={tradeTab}
              onChange={(id) => setTradeTab(id as 'trade' | 'fund')}
              panelId="trade-fund-panel"
              tabs={[
                { id: 'trade', label: 'Trade' },
                { id: 'fund', label: 'Fund' },
              ]}
            >
              {tradeTab === 'trade' ? (
                address && orderDesk && orderDesk.pairs.length > 0 ? (
                  <OrderForm
                    desk={orderDesk}
                    notes={notes}
                    bookIndex={bookIndex}
                    userPubkey={address}
                    trustless={trustlessDesk}
                    disabledReason={orderDisabledReason}
                    onDone={reloadNotes}
                  />
                ) : (
                  <p className="muted">
                    {address
                      ? bookIndex.status === 'synced'
                        ? 'No pairs registered.'
                        : 'Waiting for verified book synchronization.'
                      : 'Connect your wallet to place orders.'}
                  </p>
                )
              ) : (
                <ShieldUnshieldPanel
                  desk={displayDesk}
                  notes={notes}
                  userPubkey={address}
                  disabledReason={fundActionsDisabled}
                  trustless={trustlessDesk}
                  onRecheck={bookIndex.status === 'error' ? bookIndex.recheck : undefined}
                  onDone={reloadNotes}
                />
              )}
            </Tabs>
          </Pane>
        </div>
      </div>
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
  noteIndexError,
  userPubkey,
  trustless,
  onDone,
}: {
  notes: Note[]
  dec: (id: number) => number
  desk: Desk
  bookIndex: BookIndexSnapshot
  noteIndexError: string | null
  userPubkey: string
  trustless: boolean
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
              {noteDisplayStatus(n, bookIndex, noteIndexError)}
            </td>
            <td>
              {n.status === 'active' && orderIsResting(n, bookIndex) && userPubkey && (
                <CancelOrderButton
                  desk={desk}
                  note={n}
                  userPubkey={userPubkey}
                  trustless={trustless}
                  onDone={onDone}
                />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function noteDisplayStatus(n: Note, bookIndex: BookIndexSnapshot, noteIndexError: string | null): string {
  if (n.status !== 'active' || n.indexed) return n.status
  if (noteIndexError?.includes('trustless note history unavailable')) return 'active · index history unavailable'
  // Any other reconcile failure is a real error, not normal indexing latency — surface it distinctly
  // rather than reusing "pending index", so a wedged event reader doesn't look like healthy waiting.
  if (noteIndexError) return 'active · index error'
  if (!n.cancel) return 'active · pending index'
  if (bookIndex.status !== 'synced') return 'order submitted · syncing book'
  return orderIsResting(n, bookIndex) ? 'resting · awaiting fill' : 'not yet on book'
}

function orderIsResting(n: Note, bookIndex: BookIndexSnapshot): boolean {
  if (!n.cancel || bookIndex.status !== 'synced') return false
  return bookIndex.orders.some((order) => normTag(order.order_leaf) === normTag(n.cancel!.order_leaf))
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
