import { useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import type { Desk, Pair } from '../api'
import { ordersFor, type BookIndexSnapshot } from '../bookIndexer'
import type { Note } from '../notes'
import { toRaw, formatAmount, computeMinOutAtPrice, parseRatio } from '../amount'
import { maxIn, planAssembly } from '../orderPlan'
import { nowSeconds } from '../time'
import { useRecovery } from '../RecoveryContext'
import { useActivity } from '../ActivityContext'
import { placeOrderTrustless } from '../trustless'
import Field from './ui/Field'
import ProgressSteps from './ui/ProgressSteps'
import Button from './ui/Button'
import HelpTip from './ui/HelpTip'

type Side = 'SELL' | 'BUY'

/** Parse the amount_in field to raw units, or null if blank/invalid. */
function parseAmountIn(amountIn: string, decimalsIn: number): bigint | null {
  if (amountIn.trim() === '') return null
  try {
    return BigInt(toRaw(amountIn, decimalsIn))
  } catch {
    return null
  }
}

/**
 * Compute raw min_out from amount_in + a limit price (quote per base), or null if either is
 * blank/invalid. The price means the same thing for both sides; only the conversion direction
 * (multiply for SELL, divide for BUY) depends on `side`.
 */
function parseMinOut(
  amountInRaw: bigint | null,
  price: string,
  side: Side,
  decimalsBase: number,
  decimalsQuote: number,
): bigint | null {
  if (amountInRaw == null || amountInRaw <= 0n || price.trim() === '') return null
  try {
    if (parseRatio(price).num <= 0n) return null
    return computeMinOutAtPrice(amountInRaw, price, side, decimalsBase, decimalsQuote)
  } catch {
    return null
  }
}

/**
 * Mirror of the contract's price-cross test (`cross_amounts`): taker `a` crosses resting maker `b`
 * when `a.min_out * b.min_out <= a.amount_in * b.amount_in`. Used to warn, before submitting, that an
 * order would match immediately rather than rest on the book.
 */
function crosses(aIn: bigint, aMinOut: bigint, bIn: bigint, bMinOut: bigint): boolean {
  return aMinOut * bMinOut <= aIn * bIn
}

/**
 * Place a resting limit order. The user picks a pair/side, an amount of the offered (in) asset, and
 * a limit price quoted as quote-per-base (the same number for both sides); min_out is computed from
 * it per side (SELL multiplies, BUY divides). The `lift` circuit consumes ONE note in full and that
 * note must already be on-chain, so if no single confirmed note equals amount_in we first assemble
 * one via in-browser-proved `join`(s) (each gated on confirmation), then prove the lift and relay a
 * fully-sponsored submit_order. On success the offered note is marked spent and an active order
 * note is saved; it becomes spendable once its proceeds appear in the indexer.
 */
export default function OrderForm({
  desk,
  notes,
  bookIndex,
  userPubkey,
  trustless = false,
  disabledReason,
  onDone,
}: {
  desk: Desk
  notes: Note[]
  bookIndex: BookIndexSnapshot
  userPubkey: string
  trustless?: boolean
  disabledReason?: string | null
  onDone: () => void
}) {
  const [pairId, setPairId] = useState(desk.pairs[0]?.pair_id ?? 0)
  const [side, setSide] = useState<Side>('SELL')
  const [amountIn, setAmountIn] = useState('')
  const [price, setPrice] = useState('')
  const [partial, setPartial] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recovery = useRecovery()
  const activity = useActivity()
  const recoveryReady = recovery.unlocked && !recovery.error

  const pair = desk.pairs.find((p) => p.pair_id === pairId) as Pair | undefined
  // SELL = give base / want quote; BUY = give quote / want base.
  const assetIn = pair ? (side === 'SELL' ? pair.base_asset : pair.quote_asset) : 0
  const assetOut = pair ? (side === 'SELL' ? pair.quote_asset : pair.base_asset) : 0
  const sym = (id: number) => desk.assets.find((a) => a.asset_id === id)?.symbol ?? `#${id}`
  const dec = (id: number) => desk.assets.find((a) => a.asset_id === id)?.decimals ?? 7

  const maxInRaw = maxIn(notes, assetIn)

  // The limit price is always quoted as quote-per-base, the same for both sides of the pair.
  const baseDecimals = pair ? dec(pair.base_asset) : 7
  const quoteDecimals = pair ? dec(pair.quote_asset) : 7

  // Parse amount_in; derive min_out and the assembly plan reactively for preview + validation.
  const amountInRaw = parseAmountIn(amountIn, dec(assetIn))
  const minOutRaw = parseMinOut(amountInRaw, price, side, baseDecimals, quoteDecimals)
  const plan =
    amountInRaw != null && amountInRaw > 0n ? planAssembly(notes, assetIn, amountInRaw) : null

  const valid =
    amountInRaw != null &&
    amountInRaw > 0n &&
    minOutRaw != null &&
    minOutRaw > 0n &&
    plan != null &&
    plan.kind !== 'impossible'

  // Will this order cross a resting opposing order and execute immediately (rather than rest)? We
  // mirror the contract's match logic against the live opposing book so we can warn before placing.
  // SELL crosses resting bids (side 0); BUY crosses resting asks (side 1).
  const opposing = ordersFor(bookIndex, pairId, side === 'SELL' ? 0 : 1)
  const willCross =
    amountInRaw != null &&
    minOutRaw != null &&
    amountInRaw > 0n &&
    minOutRaw > 0n &&
    opposing.some(
      (o) =>
        Number(o.expiry) > nowSeconds() &&
        BigInt(o.remaining_in) > 0n &&
        crosses(amountInRaw, minOutRaw, BigInt(o.amount_in), BigInt(o.min_out)),
    )

  // Field-level errors (blank while the field is empty).
  const amountError =
    amountIn.trim() === ''
      ? null
      : amountInRaw == null
        ? `Enter a valid amount with at most ${dec(assetIn)} decimal places.`
        : amountInRaw <= 0n
          ? 'Amount must be greater than zero.'
          : amountInRaw > maxInRaw
            ? `Exceeds max ${formatAmount(maxInRaw, dec(assetIn))} ${sym(assetIn)}.`
            : plan?.kind === 'impossible'
              ? plan.reason
              : null
  const priceError = (() => {
    if (price.trim() === '') return null
    try {
      return parseRatio(price).num > 0n ? null : 'Enter a positive price.'
    } catch {
      return 'Enter a valid price.'
    }
  })()

  // Human-readable preview of what placing the order will do (positive-path only).
  const preview = (() => {
    if (amountInRaw == null || amountError) return null
    if (plan?.kind === 'assemble') {
      const single = plan.steps.length === 1 && plan.steps[0].op === 'split'
      if (single) return 'Will split a note to the exact amount, then place the order.'
      return `Will prepare the exact note in ${plan.steps.length} step${plan.steps.length > 1 ? 's' : ''}, then place the order.`
    }
    if (plan?.kind === 'direct') return 'A matching note is ready — places in one step.'
    return null
  })()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (disabledReason) return
    if (amountInRaw == null || minOutRaw == null || plan == null) return
    if (plan.kind === 'impossible') {
      setError(plan.reason)
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (trustless) {
        setStatus('Proving & submitting in browser…')
        await placeOrderTrustless(desk, {
          address: userPubkey,
          pairId,
          side: side === 'SELL' ? 1 : 0,
          amountIn: amountInRaw.toString(),
          minOut: minOutRaw.toString(),
          partialAllowed: partial,
        })
        setStatus('Order submitted')
      } else {
        setStatus('Queueing order…')
        const operation = await activity.enqueue({
          kind: 'place_order', desk_id: desk.id, pair_id: pairId, side,
          amount_in: amountInRaw.toString(), min_out: minOutRaw.toString(), partial_allowed: partial,
        })
        setStatus(`Queued · ${operation.id.slice(0, 8)}`)
      }
      onDone()
    } catch (e) {
      setError(errorMessage(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <div className="row" style={{ gap: 'var(--sp-3)' }}>
        <Field id="order-pair" label="Pair">
          <select value={pairId} onChange={(e) => setPairId(Number(e.target.value))}>
            {desk.pairs.map((p) => (
              <option key={p.pair_id} value={p.pair_id}>
                {sym(p.base_asset)}/{sym(p.quote_asset)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="order-side" label="Side">
          <select value={side} onChange={(e) => setSide(e.target.value as Side)}>
            <option value="SELL">SELL {pair && sym(pair.base_asset)}</option>
            <option value="BUY">BUY {pair && sym(pair.base_asset)}</option>
          </select>
        </Field>
      </div>
      <Field
        id="order-amount"
        label={`Amount in (${sym(assetIn)})`}
        help={`Max ${formatAmount(maxInRaw, dec(assetIn))} available.`}
        error={amountError}
      >
        <div className="field-row">
          <input
            value={amountIn}
            onChange={(e) => setAmountIn(e.target.value)}
            inputMode="decimal"
            placeholder={formatAmount(maxInRaw, dec(assetIn))}
            style={{ flex: 1 }}
          />
          <Button size="sm" onClick={() => setAmountIn(formatAmount(maxInRaw, dec(assetIn)))} disabled={maxInRaw <= 0n || busy}>
            Max
          </Button>
        </div>
      </Field>
      <Field
        id="order-price"
        label={
          <>
            Limit price ({pair && sym(pair.quote_asset)} per {pair && sym(pair.base_asset)}){' '}
            <HelpTip>Quote asset per 1 base asset. SELL fills at this price or higher; BUY at this price or lower.</HelpTip>
          </>
        }
        error={priceError}
      >
        <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
      </Field>
      <Field id="order-minout" label={`Min out (${sym(assetOut)})`}>
        <input value={minOutRaw != null ? formatAmount(minOutRaw, dec(assetOut)) : ''} readOnly />
      </Field>
      <label style={{ textTransform: 'none', color: 'var(--fg)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
        Allow partial fills
        <HelpTip>If on, the order can rest and fill in integer lots. If off, it fills fully or not at all.</HelpTip>
      </label>
      {willCross && valid && !busy && !error && (
        <div className="banner warn" role="status">
          <div className="banner-body">
            Crosses the book — this order will match a resting {side === 'SELL' ? 'bid' : 'ask'} and
            execute immediately (fully or partially) instead of resting.
          </div>
        </div>
      )}
      {preview && !error && <div className="muted">{preview}</div>}
      <button className="btn-primary btn-block" type="submit" disabled={busy || !valid || !recoveryReady || !!disabledReason}>
        {busy ? 'Working…' : recoveryReady ? 'Place order' : 'Enable / repair recovery first'}
      </button>
      {disabledReason && <div className="muted">{disabledReason}</div>}
      <ProgressSteps running={busy} step={status} />
      {!busy && status && !error && <div className="status-dot ok">{status}</div>}
      {error && <div className="banner err" role="alert">{error}</div>}
    </form>
  )
}
