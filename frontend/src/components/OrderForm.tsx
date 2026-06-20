import { useEffect, useState } from 'react'
import type { Desk, Pair } from '../api'
import { api } from '../api'
import { randomField } from '../crypto'
import { orderTerms } from '../noir'
import { proveLift, b64 } from '../prove'
import { addNote, updateNote, type Note } from '../notes'
import { toRaw, formatAmount, computeMinOut, parseRatio } from '../amount'
import { maxIn, planAssembly } from '../orderPlan'
import { runAssembly } from '../orchestrate'
import { nowMs, nowSeconds } from '../time'

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

/** Compute raw min_out from amount_in + ratio, or null if either is blank/invalid. */
function parseMinOut(
  amountInRaw: bigint | null,
  ratio: string,
  decimalsIn: number,
  decimalsOut: number,
): bigint | null {
  if (amountInRaw == null || amountInRaw <= 0n || ratio.trim() === '') return null
  try {
    if (parseRatio(ratio).num <= 0n) return null
    return computeMinOut(amountInRaw, ratio, decimalsIn, decimalsOut)
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

interface BookEntry {
  amount_in: string | number
  min_out: string | number
  remaining_in: string | number
  expiry: string | number
}

/**
 * Place a resting limit order. The user picks a pair/side, an amount of the offered (in) asset, and
 * a ratio (out per 1 in); min_out is computed. The `lift` circuit consumes ONE note in full and that
 * note must already be on-chain, so if no single confirmed note equals amount_in we first assemble
 * one via in-browser-proved `join`(s) (each gated on confirmation), then prove the lift and relay a
 * fully-sponsored submit_order. On success the offered note is marked spent and a pending proceeds
 * note is saved.
 */
export default function OrderForm({
  desk,
  notes,
  onDone,
}: {
  desk: Desk
  notes: Note[]
  onDone: () => void
}) {
  const [pairId, setPairId] = useState(desk.pairs[0]?.pair_id ?? 0)
  const [side, setSide] = useState<Side>('SELL')
  const [amountIn, setAmountIn] = useState('')
  const [ratio, setRatio] = useState('')
  const [partial, setPartial] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pair = desk.pairs.find((p) => p.pair_id === pairId) as Pair | undefined
  // SELL = give base / want quote; BUY = give quote / want base.
  const assetIn = pair ? (side === 'SELL' ? pair.base_asset : pair.quote_asset) : 0
  const assetOut = pair ? (side === 'SELL' ? pair.quote_asset : pair.base_asset) : 0
  const sym = (id: number) => desk.assets.find((a) => a.asset_id === id)?.symbol ?? `#${id}`
  const dec = (id: number) => desk.assets.find((a) => a.asset_id === id)?.decimals ?? 7

  const maxInRaw = maxIn(notes, assetIn)

  // Parse amount_in; derive min_out and the assembly plan reactively for preview + validation.
  const amountInRaw = parseAmountIn(amountIn, dec(assetIn))
  const minOutRaw = parseMinOut(amountInRaw, ratio, dec(assetIn), dec(assetOut))
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
  const [willCross, setWillCross] = useState(false)
  useEffect(() => {
    let alive = true
    const aIn = amountInRaw
    const aMinOut = minOutRaw
    const oppSide = side === 'SELL' ? 0 : 1
    // Only query the opposing book when inputs are well-formed; otherwise the answer is just "no".
    const probe =
      aIn != null && aMinOut != null && aIn > 0n && aMinOut > 0n
        ? api.getBook(desk.id, pairId, oppSide).then((r) => {
            const now = nowSeconds()
            const entries = (r.orders as BookEntry[]) ?? []
            return entries.some(
              (o) =>
                Number(o.expiry) > now &&
                BigInt(o.remaining_in) > 0n &&
                crosses(aIn, aMinOut, BigInt(o.amount_in), BigInt(o.min_out)),
            )
          })
        : Promise.resolve(false)
    probe.then((cross) => alive && setWillCross(cross)).catch(() => alive && setWillCross(false))
    return () => {
      alive = false
    }
    // amountInRaw/minOutRaw are bigints, compared by value via Object.is in the dep array.
  }, [desk.id, pairId, side, amountInRaw, minOutRaw])

  // Human-readable preview of what placing the order will do.
  const preview = (() => {
    if (amountInRaw == null) return null
    if (amountInRaw > maxInRaw) return `Exceeds max ${formatAmount(maxInRaw, dec(assetIn))} ${sym(assetIn)}.`
    if (plan?.kind === 'impossible') return plan.reason
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
    if (amountInRaw == null || minOutRaw == null || plan == null) return
    if (plan.kind === 'impossible') {
      setError(plan.reason)
      return
    }
    setBusy(true)
    setError(null)
    try {
      // Resolve a single confirmed note of exactly amount_in (assembling it first if needed).
      let offer: Note
      if (plan.kind === 'direct') {
        const found = notes.find((n) => n.id === plan.noteId)
        if (!found) throw new Error('Offer note no longer available; please retry.')
        offer = found
      } else {
        setStatus('Preparing note…')
        offer = await runAssembly(desk, plan.steps, notes, setStatus)
      }

      const minOut = minOutRaw.toString()
      const expiry = nowSeconds() + 7 * 86400
      const rho_out = randomField()
      const rho_ord = randomField()
      setStatus('Deriving order terms…')
      const terms = await orderTerms({
        sk: offer.sk,
        rho_in: offer.rho,
        rho_out,
        rho_ord,
        asset_in: assetIn,
        amount_in: offer.amount,
        asset_out: assetOut,
        min_out: minOut,
        expiry,
        partial_allowed: partial ? 1 : 0,
      })
      setStatus('Fetching membership path…')
      const proof = await api.getNoteProof(desk.id, offer.owner_tag)
      setStatus('Proving (UltraHonk, in-browser)…')
      const bundle = await proveLift({
        rho_in: offer.rho,
        sk_o: offer.sk,
        path: proof.siblings,
        index_bits: proof.index_bits,
        root: proof.root,
        nullifier_in: terms.nullifier_in,
        asset_in: assetIn,
        amount_in: offer.amount,
        asset_out: assetOut,
        min_out: minOut,
        output_owner_tag: terms.output_owner_tag,
        cancel_owner_tag: terms.cancel_owner_tag,
        expiry,
        partial_allowed: partial ? 1 : 0,
        order_leaf: terms.order_leaf,
      })
      setStatus('Submitting (sponsored)…')
      await api.relayOrder(desk.id, b64(bundle.proof), b64(bundle.publicInputs))

      // The offered note is now spent; record a pending proceeds note (asset_out @ output tag).
      await updateNote(offer.id, { status: 'spent' })
      await addNote({
        id: crypto.randomUUID(),
        deskId: desk.id,
        role: 'order-output',
        asset_id: assetOut,
        symbol: sym(assetOut),
        amount: minOut,
        sk: offer.sk,
        rho: rho_out,
        owner_tag: terms.output_owner_tag,
        status: 'pending',
        createdAt: nowMs(),
        // Everything needed to later prove a cancel and reclaim the locked asset_in funds.
        cancel: {
          rho_ord,
          order_leaf: terms.order_leaf,
          cancel_owner_tag: terms.cancel_owner_tag,
          pairId,
          side: side === 'SELL' ? 1 : 0,
          asset_in: assetIn,
          symbol_in: sym(assetIn),
          amount_in: offer.amount,
        },
      })
      setStatus('Order submitted.')
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="row" style={{ alignItems: 'flex-end' }}>
      <div>
        <label>Pair</label>
        <select value={pairId} onChange={(e) => setPairId(Number(e.target.value))}>
          {desk.pairs.map((p) => (
            <option key={p.pair_id} value={p.pair_id}>
              {sym(p.base_asset)}/{sym(p.quote_asset)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label>Side</label>
        <select value={side} onChange={(e) => setSide(e.target.value as Side)}>
          <option value="SELL">SELL {pair && sym(pair.base_asset)}</option>
          <option value="BUY">BUY {pair && sym(pair.base_asset)}</option>
        </select>
      </div>
      <div>
        <label>
          Amount in ({sym(assetIn)}) · max {formatAmount(maxInRaw, dec(assetIn))}
        </label>
        <input
          value={amountIn}
          onChange={(e) => setAmountIn(e.target.value)}
          inputMode="decimal"
          placeholder={formatAmount(maxInRaw, dec(assetIn))}
        />
        <button
          type="button"
          style={{ padding: '2px 8px', marginLeft: 6 }}
          onClick={() => setAmountIn(formatAmount(maxInRaw, dec(assetIn)))}
          disabled={maxInRaw <= 0n}
        >
          max
        </button>
      </div>
      <div>
        <label>
          Ratio ({sym(assetOut)} per {sym(assetIn)})
        </label>
        <input value={ratio} onChange={(e) => setRatio(e.target.value)} inputMode="decimal" />
      </div>
      <div>
        <label>Min out ({sym(assetOut)})</label>
        <input value={minOutRaw != null ? formatAmount(minOutRaw, dec(assetOut)) : ''} readOnly />
      </div>
      <div>
        <label>
          <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />{' '}
          partial
        </label>
      </div>
      <button type="submit" disabled={busy || !valid}>
        {busy ? 'Working…' : 'Place order'}
      </button>
      {willCross && valid && !busy && !error && (
        <span className="warn">
          ⚠ Crosses the book — this order will match a resting {side === 'SELL' ? 'bid' : 'ask'} and
          execute immediately (fully or partially) instead of resting.
        </span>
      )}
      {preview && !error && <span className="muted">{preview}</span>}
      {status && <span className="muted">{status}</span>}
      {error && <span className="err">{error}</span>}
    </form>
  )
}
