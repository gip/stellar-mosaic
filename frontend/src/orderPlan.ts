// Pure planning logic for assembling a single confirmed note of an exact amount out of the wallet's
// spendable notes. The order (`lift`) circuit consumes ONE note in full and that note must already
// be on-chain. The `join` circuit denominates notes: with two real inputs it merges/carves
// (2 -> {target, change}); with a null padding second input it SPLITS one note (1 -> {target,
// change}). So any amount up to the spendable balance is reachable. This module decides the steps —
// it does no IO and is independent of React (see orchestrate.ts for the async executor).
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
