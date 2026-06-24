// Pure planning logic for assembling a single confirmed note of an exact amount out of the wallet's
// spendable notes. The order (`lift`) circuit consumes ONE note in full and that note must already
// be on-chain. The `join` circuit denominates notes: with two real inputs it merges/carves
// (2 -> {target, change}); with a null padding second input it SPLITS one note (1 -> {target,
// change}). So any amount up to the spendable balance is reachable. This module decides the steps —
// it does no IO and is independent of React (see orchestrate.ts for the async executor).
import type { BookOrder } from './api'
import type { Note } from './notes'

/** A step input is either an existing note or the target output of the previous step in a chain. */
export type JoinInputRef = { type: 'note'; id: string } | { type: 'prev' }

export type AssemblyStep =
  | { op: 'split'; a: JoinInputRef; targetRaw: string; changeRaw: string } // one note -> target + change
  | { op: 'join'; a: JoinInputRef; b: JoinInputRef; targetRaw: string; changeRaw: string } // two -> target + change

export type AssemblyPlan =
  | { kind: 'direct'; noteId: string } // a confirmed note already equals the target
  | { kind: 'assemble'; steps: AssemblyStep[] } // run these in order; last target == amount
  | { kind: 'impossible'; reason: string }

/** Indexed, active notes of a given asset — the only ones a join/order can consume. */
export function spendableNotes(notes: Note[], assetId: number): Note[] {
  return notes.filter((n) => n.status === 'active' && n.indexed && n.asset_id === assetId && n.operation_state !== 'reserved')
}

/** Maximum amount_in offerable for an asset: the sum of all its spendable notes (raw units). */
export function maxIn(notes: Note[], assetId: number): bigint {
  return spendableNotes(notes, assetId).reduce((s, n) => s + BigInt(n.amount), 0n)
}

/**
 * Decide how to produce a single confirmed note of exactly `targetRaw` of `assetId`:
 *  - a note already equals it -> place directly;
 *  - a single note exceeds it -> one SPLIT carves {target, change} (no second note needed);
 *  - otherwise -> merge notes largest-first with joins until the running sum reaches the target,
 *    where the final join carves it.
 * The only unreachable case is insufficient balance.
 */
export function planAssembly(notes: Note[], assetId: number, targetRaw: bigint): AssemblyPlan {
  if (targetRaw <= 0n) return { kind: 'impossible', reason: 'Amount must be greater than zero.' }
  const sp = spendableNotes(notes, assetId)
  const total = sp.reduce((s, n) => s + BigInt(n.amount), 0n)
  if (total < targetRaw) return { kind: 'impossible', reason: 'Amount exceeds your spendable balance.' }

  const exact = sp.find((n) => BigInt(n.amount) === targetRaw)
  if (exact) return { kind: 'direct', noteId: exact.id }

  // A single note larger than the target: split it directly (cheapest — one step, no partner).
  // Pick the smallest such note to keep the leftover change small.
  const covering = sp.filter((n) => BigInt(n.amount) > targetRaw).sort((x, y) => {
    const a = BigInt(x.amount)
    const b = BigInt(y.amount)
    return a < b ? -1 : a > b ? 1 : 0
  })
  if (covering.length > 0) {
    const n = covering[0]
    return {
      kind: 'assemble',
      steps: [
        {
          op: 'split',
          a: { type: 'note', id: n.id },
          targetRaw: targetRaw.toString(),
          changeRaw: (BigInt(n.amount) - targetRaw).toString(),
        },
      ],
    }
  }

  // No single note covers the target, but the balance does (so there are >= 2 notes). Merge
  // largest-first; each join either carves the target (once the running sum reaches it) or merges
  // two notes fully (change 0) and continues.
  const sorted = [...sp].sort((x, y) => {
    const a = BigInt(x.amount)
    const b = BigInt(y.amount)
    return a < b ? 1 : a > b ? -1 : 0
  })
  const steps: AssemblyStep[] = []
  let accRef: JoinInputRef = { type: 'note', id: sorted[0].id }
  let accAmt = BigInt(sorted[0].amount)
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i]
    const sum = accAmt + BigInt(n.amount)
    if (sum >= targetRaw) {
      steps.push({
        op: 'join',
        a: accRef,
        b: { type: 'note', id: n.id },
        targetRaw: targetRaw.toString(),
        changeRaw: (sum - targetRaw).toString(),
      })
      return { kind: 'assemble', steps }
    }
    steps.push({ op: 'join', a: accRef, b: { type: 'note', id: n.id }, targetRaw: sum.toString(), changeRaw: '0' })
    accRef = { type: 'prev' }
    accAmt = sum
  }
  // Unreachable: total >= target guarantees a carve above. Defensive only.
  return { kind: 'impossible', reason: 'Could not assemble the requested amount.' }
}

// --- taker-side matching (WS4): pick the makers a just-placed crossing order should settle against ---

/** The taker order's public terms, in raw integer units. */
export interface TakerTerms {
  asset_in: number
  asset_out: number
  amount_in: bigint
  min_out: bigint
  partial: boolean
}

/** The chosen full-fill makers + the derived integer outputs the `match` circuit/contract require. */
export interface MatchSelection {
  makers: BookOrder[] // 1..3 makers, fully consumed
  totalOut: bigint // asset_out the taker receives = sum(maker.amount_in)
  paid: bigint[] // per maker: maker.min_out the taker pays (in asset_in), == proceeds minted to it
  remainder: bigint // taker's leftover amount_in re-rested (0 = fully consumed)
  remMinOut: bigint // remainder's min_out at the taker's EXACT limit ratio (0 when no remainder)
}

function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Mirror of the contract/circuit price cross: taker crosses maker when
 * `t_min_out * m_min_out <= t_amount_in * m_amount_in`. */
function crossesT(tIn: bigint, tMinOut: bigint, mIn: bigint, mMinOut: bigint): boolean {
  return tMinOut * mMinOut <= tIn * mIn
}

/**
 * Choose up to 3 resting makers a crossing taker should settle against, honoring every constraint the
 * `match` circuit enforces — so the resulting match always verifies:
 *  - makers oppose the taker's orientation, are unexpired, and price-cross the taker;
 *  - they are fully consumed; the taker pays sum(maker.min_out) <= its amount_in;
 *  - any leftover re-rests at the taker's EXACT integer limit ratio
 *    (`rem_min_out * t_amount_in == t_min_out * remainder`), which requires divisibility.
 * Best price for the taker first; the largest valid (1..3) prefix wins. Returns null when nothing
 * crosses or no prefix yields a clean (integer-ratio, or zero) remainder — the order simply rests.
 */
export function selectMatch(taker: TakerTerms, book: BookOrder[], now: number): MatchSelection | null {
  if (taker.amount_in <= 0n || taker.min_out <= 0n) return null
  const cand = book.filter(
    (o) =>
      o.active &&
      o.asset_in === taker.asset_out &&
      o.asset_out === taker.asset_in &&
      o.expiry > now &&
      BigInt(o.amount_in) > 0n &&
      BigInt(o.min_out) > 0n &&
      crossesT(taker.amount_in, taker.min_out, BigInt(o.amount_in), BigInt(o.min_out)),
  )
  // Best for the taker first: most received (m.amount_in) per unit paid (m.min_out).
  cand.sort((a, b) =>
    cmpBig(BigInt(b.amount_in) * BigInt(a.min_out), BigInt(a.amount_in) * BigInt(b.min_out)),
  )
  // Greedy prefix (<=3) whose cumulative payment never exceeds what the taker holds.
  const chosen: BookOrder[] = []
  let paidSum = 0n
  for (const m of cand) {
    if (chosen.length >= 3) break
    const next = paidSum + BigInt(m.min_out)
    if (next > taker.amount_in) break
    chosen.push(m)
    paidSum = next
  }
  // Trim worst-price makers until the remainder re-rests cleanly (zero, or an exact integer ratio).
  for (; chosen.length > 0; chosen.pop()) {
    const paid = chosen.map((m) => BigInt(m.min_out))
    const paidTotal = paid.reduce((s, x) => s + x, 0n)
    const remainder = taker.amount_in - paidTotal
    const totalOut = chosen.reduce((s, m) => s + BigInt(m.amount_in), 0n)
    if (remainder === 0n) {
      return { makers: [...chosen], totalOut, paid, remainder: 0n, remMinOut: 0n }
    }
    if (!taker.partial) continue // all-or-nothing taker: only a full consumption is acceptable
    if ((taker.min_out * remainder) % taker.amount_in === 0n) {
      const remMinOut = (taker.min_out * remainder) / taker.amount_in
      if (remMinOut > 0n) return { makers: [...chosen], totalOut, paid, remainder, remMinOut }
    }
  }
  return null
}
