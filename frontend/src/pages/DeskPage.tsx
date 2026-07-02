import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { errorMessage } from '@mosaic/sdk'
import { api, type Asset, type Desk, type DeskCustody, type Fill } from '../api'
import { NATIVE_EVM_SENTINEL } from '../baseDeployment'
import { useWallet } from '../WalletContext'
import OrderBook from '../components/OrderBook'
import OrderForm from '../components/OrderForm'
import RecentTrades from '../components/RecentTrades'
import ShieldUnshieldPanel from '../components/ShieldUnshieldPanel'
import CancelOrderButton from '../components/CancelOrderButton'
import Pane from '../components/ui/Pane'
import Tabs from '../components/ui/Tabs'
import StatusDot, { type StatusTone } from '../components/ui/StatusDot'
import Modal from '../components/ui/Modal'
import ScrollTable from '../components/ui/ScrollTable'
import Toasts, { type ToastItem } from '../components/Toasts'
import { notesForDesk, reconcile, type Note } from '../notes'
import { formatAmount } from '../amount'
import { isRecoveryUnlocked, syncRecoveryNow } from '../recovery'
import { ordersFor, type BookIndexSnapshot } from '../bookIndexer'
import { useBookIndex } from '../useBookIndex'
import { setSubmissionMode, submissionMode } from '../directTransaction'
import { stellarExpertTxUrl } from '../explorer'
import { useStorageMode, type StorageMode } from '../StorageModeContext'

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

/** Contract/config rows shared by the logged-in and public desk-details tables. `submissionRow`
 * (self-submit vs. sponsor) is wallet-specific, so the public view omits it. */
function DeskDetailsTable({
  desk,
  verifiedDesk,
  root,
  bookIndex,
  submissionRow,
}: {
  desk: Desk
  verifiedDesk: Desk
  root: string | null
  bookIndex: BookIndexSnapshot
  submissionRow?: ReactNode
}) {
  return (
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
                {desk.base_deployment ? `not deployed (${desk.base_deployment.status})` : 'not deployed'}
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
        {submissionRow}
        <tr>
          <th>Book index</th>
          <td>
            {bookIndex.status} · ledger {bookIndex.lastLedger}
            {bookIndex.status === 'syncing' &&
              ` · sequence ${bookIndex.lastSequence}/${bookIndex.targetSequence}`}
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
  )
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
  // A visitor with no connected wallet has no local desk registry and no session — resolve
  // through the same public, unauthenticated path real Trusted-mode users use (`mcp.getDesk` /
  // `syncTrustedBookIndex`), instead of the local-only Trustless path storageMode falls back to.
  const loggedOut = !address
  const effectiveMode: StorageMode = loggedOut ? 'trusted' : storageMode.mode
  const [desk, setDesk] = useState<Desk | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [fills, setFills] = useState<Fill[]>([])
  const [custody, setCustody] = useState<DeskCustody | null>(null)
  const trustlessDesk = storageMode.mode === 'trustless'
  const [error, setError] = useState<string | null>(null)
  const [noteIndexError, setNoteIndexError] = useState<string | null>(null)
  const [submitMode, setSubmitMode] = useState<'direct' | 'sponsored'>(submissionMode())
  const [lastVerifiedDesk, setLastVerifiedDesk] = useState<Desk | null>(null)
  const [activePairId, setActivePairId] = useState<number | null>(null)
  const [tradeTab, setTradeTab] = useState<'trade' | 'fund'>('trade')
  const bookIndex = useBookIndex(effectiveMode, desk, networkPassphrase)

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
      setFills([])
      setCustody(null)
      setError(null)
      setNoteIndexError(null)
      setLastVerifiedDesk(null)
    })
    api
      .getDesk(effectiveMode, deskId)
      .then((nextDesk) => {
        if (!active) return
        setDesk(nextDesk)
      })
      .catch((e) => {
        if (!active) return
        const message = errorMessage(e)
        setError(loggedOut && /not found/i.test(message) ? 'Desk not found.' : message)
      })
    if (!loggedOut) reloadNotes()
    return () => { active = false }
  }, [effectiveMode, loggedOut, deskId, reloadNotes])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ mode?: string }>).detail
      if (!detail?.mode || detail.mode === storageMode.mode) reloadNotes()
    }
    window.addEventListener('mosaic-notes-changed', handler)
    return () => window.removeEventListener('mosaic-notes-changed', handler)
  }, [storageMode.mode, reloadNotes])

  // Poll desk-wide custody totals (Stellar + Base). Public reads, so this runs logged-out too.
  useEffect(() => {
    if (!deskId) return
    let alive = true
    const tick = () =>
      api
        .getDeskCustody(effectiveMode, deskId)
        .then((c) => alive && setCustody(c))
        .catch(() => {})
    tick()
    const h = setInterval(tick, 10000)
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [effectiveMode, deskId])

  // Auto-refresh the on-chain root every 5s as a liveness signal. Not shown in the public view.
  useEffect(() => {
    if (!deskId || loggedOut) return
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
  }, [storageMode.mode, deskId, loggedOut])

  // Reconcile local notes against on-chain state every 7s so filled proceeds appear. Nothing to
  // reconcile without a wallet.
  useEffect(() => {
    if (!deskId || loggedOut) return
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
  }, [storageMode.mode, deskId, address, loggedOut, reloadNotes])

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

  // Poll the desk's public `filled` events for the desk-wide trade tape. Reads straight from the
  // chain by contract_id (no wallet/auth), so this runs logged-out too and feeds the public view.
  useEffect(() => {
    if (!deskId) return
    let alive = true
    const tick = () =>
      api
        .getFills(effectiveMode, deskId)
        .then((r) => alive && setFills(r.fills ?? []))
        .catch(() => {})
    tick()
    const h = setInterval(tick, 7000)
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [effectiveMode, deskId])

  // Toast the fills destined for our own order-output notes. Derives from the shared `fills` state:
  // the first observation silently records every existing fill id (so historical fills don't toast);
  // only fills that show up afterwards — i.e. trades that cross during this session — raise one.
  const seenFills = useRef<Set<string>>(new Set())
  const fillsSeeded = useRef(false)
  useEffect(() => {
    seenFills.current = new Set()
    fillsSeeded.current = false
  }, [deskId])
  useEffect(() => {
    if (!desk || loggedOut) return
    const symOf = (id: number) => desk.assets.find((a) => a.asset_id === id)?.symbol ?? `#${id}`
    const decOf = (id: number) => desk.assets.find((a) => a.asset_id === id)?.decimals ?? 7
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
  }, [fills, desk, loggedOut])

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

  // No wallet, no session: just the desk's public identity and its live order book.
  if (loggedOut) {
    return (
      <>
        <div className="desk-head">
          <h1 className="desk-title">{desk.name}</h1>
          <StatusDot tone={bookTone} title={bookIndex.error ?? undefined}>
            Book {bookIndex.status}
            {bookIndex.status === 'syncing' &&
              ` · seq ${bookIndex.lastSequence}/${bookIndex.targetSequence}`}
          </StatusDot>
        </div>
        <ShieldedBalancesBand assets={verifiedDesk.assets} custody={custody} dec={dec} mine={null} />
        <div className="stack">
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
                    notes={[]}
                    userPubkey=""
                    trustless={false}
                    onCancel={() => {}}
                  />
                )}
              </>
            )}
          </Pane>

          <Pane title="Recent trades">
            <RecentTrades desk={verifiedDesk} fills={fills} sym={sym} dec={dec} />
          </Pane>

          <Pane title="Desk details">
            <details>
              <summary className="muted">Addresses &amp; config</summary>
              <ScrollTable>
                <DeskDetailsTable desk={desk} verifiedDesk={verifiedDesk} root={root} bookIndex={bookIndex} />
              </ScrollTable>
            </details>
          </Pane>
        </div>
      </>
    )
  }

  return (
    <>
      <Toasts items={toasts} onDismiss={dismissToast} />
      <div className="desk-head">
        <h1 className="desk-title">{desk.name}</h1>
        <StatusDot tone={bookTone} title={bookIndex.error ?? undefined}>
          Book {bookIndex.status}
          {bookIndex.status === 'syncing' &&
            ` · seq ${bookIndex.lastSequence}/${bookIndex.targetSequence}`}
        </StatusDot>
      </div>

      <ShieldedBalancesBand assets={verifiedDesk.assets} custody={custody} dec={dec} mine={mineRawByAsset(notes)} />

      <div className="desk-grid">
        {/* Left rail — notes, desk config */}
        <div className="stack">
          <Pane title="My notes">
            {notes.length === 0 ? (
              <p className="muted">No notes yet.</p>
            ) : (
              <>
                <details open>
                  <summary>Active ({active.length})</summary>
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
                <details>
                  <summary className="muted">Spent ({history.length})</summary>
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
              </>
            )}
          </Pane>

          <Pane title="Desk details">
            <details>
              <summary className="muted">Addresses &amp; config</summary>
              <ScrollTable>
                <DeskDetailsTable
                  desk={desk}
                  verifiedDesk={verifiedDesk}
                  root={root}
                  bookIndex={bookIndex}
                  submissionRow={
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
                  }
                />
              </ScrollTable>
            </details>
          </Pane>
        </div>

        {/* Center — order book + trade tape */}
        <div className="stack">
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

          <Pane title="Recent trades">
            <RecentTrades desk={verifiedDesk} fills={fills} sym={sym} dec={dec} />
          </Pane>
        </div>

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
  const [selected, setSelected] = useState<Note | null>(null)
  return (
    <>
      <table className="notes-table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Pair</th>
            <th>Amount</th>
            <th className="col-status">Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {notes.map((n) => {
            const status = noteDisplayStatus(n, bookIndex, noteIndexError)
            return (
              <tr
                key={n.id}
                className="note-row"
                onClick={() => setSelected(n)}
                title="Click for details"
              >
                <td>{noteType(n)}</td>
                <td>{notePair(n, desk)}</td>
                <td>
                  {formatAmount(n.amount, dec(n.asset_id))} {n.symbol}
                </td>
                <td className="col-status">
                  <StatusDot tone={status.tone} title={status.text}>
                    <span className="sr-only">{status.text}</span>
                  </StatusDot>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
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
            )
          })}
        </tbody>
      </table>
      {selected && (
        <NoteDetailsModal
          note={selected}
          desk={desk}
          dec={dec}
          status={noteDisplayStatus(selected, bookIndex, noteIndexError)}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  )
}

/** Full detail for a single note, opened by clicking its row. Shows every stored field —
 * including the full owner tag and status string that the table row only hints at. */
function NoteDetailsModal({
  note,
  desk,
  dec,
  status,
  onClose,
}: {
  note: Note
  desk: Desk
  dec: (id: number) => number
  status: { text: string; tone: StatusTone }
  onClose: () => void
}) {
  const mono = (v: string) => (
    <span className="mono" title={v}>
      {v}
    </span>
  )
  // Ordered from most human-relevant to most technical: what the note is and its worth,
  // then its lifecycle state, then the cryptographic identifiers, then provenance/ops.
  const rows: Array<[string, ReactNode]> = [
    ['Type', noteType(note)],
    ['Pair', notePair(note, desk)],
    ['Asset', `${note.symbol} (#${note.asset_id})`],
    ['Amount', `${formatAmount(note.amount, dec(note.asset_id))} (${note.amount} raw)`],
    [
      'Status',
      <StatusDot tone={status.tone}>{status.text}</StatusDot>,
    ],
    ['Role', note.role],
    ['Indexed', note.indexed ? 'yes' : 'no'],
  ]
  if (note.leaf_index !== undefined) rows.push(['Leaf index', String(note.leaf_index)])
  rows.push(['Owner tag', mono(note.owner_tag)])
  if (note.cancel) {
    rows.push(['Order leaf', mono(note.cancel.order_leaf)])
    rows.push(['Cancel owner tag', mono(note.cancel.cancel_owner_tag)])
  }
  rows.push(['Note id', mono(note.id)])
  if (note.txHash)
    rows.push([
      'Tx hash',
      <a
        className="mono"
        href={stellarExpertTxUrl(note.txHash)}
        target="_blank"
        rel="noreferrer"
        title={`View ${note.txHash} on Stellar Expert`}
      >
        {note.txHash}
      </a>,
    ])
  rows.push(['Created', new Date(note.createdAt).toLocaleString()])
  if (note.updatedAt) rows.push(['Updated', new Date(note.updatedAt).toLocaleString()])
  if (note.recovery_state) rows.push(['Recovery', note.recovery_state])
  if (note.operation_id) rows.push(['Operation', `${note.operation_id} (${note.operation_state ?? '—'})`])
  return (
    <Modal title="Note details" onClose={onClose}>
      <dl className="detail-grid">
        {rows.map(([label, value], i) => (
          <div className="detail-row" key={i}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}

/** Status text plus a traffic-light tone: green = spendable/settled, yellow = in-flight
 * (indexing or book-sync latency), red = a real reconcile error needing attention.
 * Terminal history states (spent/cancelled) are idle grey. */
function noteDisplayStatus(
  n: Note,
  bookIndex: BookIndexSnapshot,
  noteIndexError: string | null,
): { text: string; tone: StatusTone } {
  if (n.status !== 'active') return { text: n.status, tone: 'idle' }
  if (n.indexed) return { text: 'active', tone: 'ok' }
  if (noteIndexError?.includes('trustless note history unavailable'))
    return { text: 'active · index history unavailable', tone: 'warn' }
  // Any other reconcile failure is a real error, not normal indexing latency — surface it distinctly
  // rather than reusing "pending index", so a wedged event reader doesn't look like healthy waiting.
  if (noteIndexError) return { text: 'active · index error', tone: 'err' }
  if (!n.cancel) return { text: 'active · pending index', tone: 'warn' }
  if (bookIndex.status !== 'synced') return { text: 'order submitted · syncing book', tone: 'warn' }
  return orderIsResting(n, bookIndex)
    ? { text: 'resting · awaiting fill', tone: 'ok' }
    : { text: 'not yet on book', tone: 'warn' }
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

/** My spendable shielded balance per asset (raw units), summed from indexed active notes. */
function mineRawByAsset(notes: Note[]): Map<number, bigint> {
  const m = new Map<number, bigint>()
  for (const n of notes) {
    if (n.status !== 'active' || !n.indexed) continue
    m.set(n.asset_id, (m.get(n.asset_id) ?? 0n) + BigInt(n.amount))
  }
  return m
}

/** Desk-wide committed total per asset (Stellar + Base, same units) for the collapsed summary line.
 * Every supported currency is listed, including those at zero. */
function deskTotalSummary(assets: Asset[], custody: DeskCustody, dec: (id: number) => number): string {
  const byAsset = new Map(custody.assets.map((a) => [a.asset_id, a]))
  const parts = assets.map((a) => {
    const c = byAsset.get(a.asset_id)
    const total = BigInt(c?.stellar ?? '0') + BigInt(c?.base ?? '0')
    return `${formatAmount(total, dec(a.asset_id))} ${a.symbol}`
  })
  return parts.length > 0 ? `Total ${parts.join(', ')}` : 'No assets'
}

/** Full-width band at the top of the desk. Collapsed by default: shows a one-line desk-wide total
 * with a chevron to reveal the per-asset breakdown — total committed on Stellar and Base (desk-wide
 * custody) contrasted with the viewer's own shielded balance. `mine` is null on the public view
 * (no wallet), which hides the Mine column. `custody` is null until the first read resolves. */
function ShieldedBalancesBand({
  assets,
  custody,
  dec,
  mine,
}: {
  assets: Asset[]
  custody: DeskCustody | null
  dec: (id: number) => number
  mine: Map<number, bigint> | null
}) {
  const [open, setOpen] = useState(false)
  const byAsset = new Map((custody?.assets ?? []).map((a) => [a.asset_id, a]))
  const cell = (raw: string | null | undefined, id: number): string => {
    if (custody === null) return '…'
    if (raw === null || raw === undefined) return '—'
    return formatAmount(raw, dec(id))
  }
  const summary = custody === null ? 'Loading…' : deskTotalSummary(assets, custody, dec)
  return (
    <section className="pane balances-band">
      <button
        type="button"
        className="balances-header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pane-title">Shielded balances</span>
        <span className="balances-summary muted">{summary}</span>
        <svg className={`chevron${open ? ' open' : ''}`} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open &&
        (assets.length === 0 ? (
          <p className="muted">No assets registered.</p>
        ) : (
          <ScrollTable>
            <table className="balances-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th className="num">Stellar</th>
                  <th className="num">Base</th>
                  {mine && <th className="num">Mine</th>}
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => {
                  const c = byAsset.get(a.asset_id)
                  return (
                    <tr key={a.asset_id}>
                      <td>{a.symbol}</td>
                      <td className="num">{cell(c?.stellar, a.asset_id)}</td>
                      <td className="num">{cell(c?.base, a.asset_id)}</td>
                      {mine && <td className="num">{formatAmount(mine.get(a.asset_id) ?? 0n, dec(a.asset_id))}</td>}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </ScrollTable>
        ))}
    </section>
  )
}
