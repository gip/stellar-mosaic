// Async execution of the note-assembly plan from orderPlan.ts. This is the single code path for
// proving + relaying a `join` and for driving a multi-join sequence:
// each join's outputs are unindexed until they land on-chain and reconcile, and the next join needs
// its input's membership proof, so the steps are inherently sequential and gated on confirmation.
import type { Desk, OrderProof } from './api'
import { api } from './api'
import { randomField } from './crypto'
import { joinTerms, matchNonce, noteNullifier, orderTerms, proceedsTag } from './noir'
import {
  proveJoin,
  proveMatch,
  proveUnshield,
  b64,
  type MatchOrderWitness,
  type MatchProceedsSlot,
  type MatchRemainder,
} from './prove'
import { recipientField } from './soroban'
import { updateNote, notesForDesk, reconcile, type Note } from './notes'
import { selectMatch, type AssemblyStep, type MatchSelection, type TakerTerms } from './orderPlan'
import { nowMs, nowSeconds } from './time'
import {
  stageRecoverableNotes,
  syncRecoveryNow,
  updateNoteAndSync,
} from './recovery'

export interface JoinResult {
  target: Note // the carved/accumulated output (active, but unspendable until indexed)
  change: Note | null // the change output, or null when change is 0
}

type Status = (s: string) => void

/** Prove + relay a withdrawal of one exact, confirmed asset note to a Stellar recipient. */
export async function executeUnshield(
  desk: Desk,
  note: Note,
  to: string,
  onStatus?: Status,
): Promise<void> {
  onStatus?.('Deriving unshield terms…')
  const [nullifier, recipient] = await Promise.all([
    noteNullifier(note.sk, note.rho, note.nonce ?? '0'),
    recipientField(to),
  ])

  onStatus?.('Fetching membership path + accumulator witness…')
  const [membership, imt] = await Promise.all([
    api.getNoteProof(desk.id, note.owner_tag),
    api.getImtWitness(desk.id, nullifier),
  ])

  onStatus?.('Proving (UltraHonk, in-browser)…')
  const bundle = await proveUnshield({
    rho_in: note.rho,
    sk_o: note.sk,
    nonce_in: note.nonce ?? '0',
    path: membership.siblings,
    index_bits: membership.index_bits,
    note_root: membership.root,
    nullifier_root_in: imt.nullifier_root_in,
    nullifier_root_out: imt.nullifier_root_out,
    low_value: imt.low_value,
    low_next_value: imt.low_next_value,
    low_next_index: imt.low_next_index,
    low_path: imt.low_path,
    low_index_bits: imt.low_index_bits,
    new_path: imt.new_path,
    new_index_bits: imt.new_index_bits,
    nullifier,
    asset: note.asset_id,
    amount: note.amount,
    recipient,
  })

  onStatus?.('Submitting (sponsored)…')
  await api.relayUnshield(desk.id, to, b64(bundle.proof), b64(bundle.publicInputs))

  // The relay only resolves after the sponsored transaction succeeds. Preserve the confirmed note
  // on every earlier failure so the user can retry without corrupting local wallet state.
  await updateNoteAndSync(note.id, { status: 'spent' })
}

// A null padding note: 32 zero siblings + zero index bits. The join circuit only checks note 2's
// membership when its amount is non-zero, so any path is accepted for a split's amount-0 input.
const ZERO_FIELD = '0x' + '0'.repeat(64)
const ZERO_PATH = Array<string>(32).fill(ZERO_FIELD)
const ZERO_BITS = Array<number>(32).fill(0)
// All-zero IMT witness for a gated (disabled) insert — e.g. a split's null second note.
const ZERO_IMT = {
  nullifier_root_in: '0', nullifier_root_out: '0', low_value: '0', low_next_value: '0',
  low_next_index: 0, low_path: ZERO_PATH, low_index_bits: ZERO_BITS,
  new_path: ZERO_PATH, new_index_bits: ZERO_BITS,
}

/**
 * Prove + relay one `join`: consume note `a` and an optional same-asset note `b` into a `target` of
 * `targetRaw` and `change` of `changeRaw` (target + change == a [+ b]). When `b` is null this is a
 * 1->2 SPLIT (the second input is a null padding note with fresh dummy secrets, amount 0). Marks the
 * consumed input(s) spent and saves fresh active outputs (reconciliation makes them spendable).
 */
export async function executeJoin(
  desk: Desk,
  a: Note,
  b: Note | null,
  targetRaw: bigint,
  changeRaw: bigint,
  onStatus?: Status,
): Promise<JoinResult> {
  const sk_out1 = randomField()
  const rho_out1 = randomField()
  const sk_out2 = randomField()
  const rho_out2 = randomField()
  // Note 2 secrets: the real note's own secret, or fresh dummy secrets for a null padding note
  // (fresh => a unique nullifier_2 that is distinct from nullifier_1 and never collides on-chain).
  const sk_2 = b ? b.sk : randomField()
  const rho_2 = b ? b.rho : randomField()
  // Input notes carry their own mint nonce; fresh wallet outputs use nonce 0.
  const nonce_1 = a.nonce ?? '0'
  const nonce_2 = b ? b.nonce ?? '0' : '0'

  onStatus?.('Deriving join terms…')
  const terms = await joinTerms({
    sk_1: a.sk,
    rho_1: a.rho,
    nonce_1,
    sk_2,
    rho_2,
    nonce_2,
    sk_out1,
    rho_out1,
    nonce_out1: '0',
    sk_out2,
    rho_out2,
    nonce_out2: '0',
  })

  onStatus?.(b ? 'Fetching membership paths…' : 'Fetching membership path…')
  const pa = await api.getNoteProof(desk.id, a.owner_tag)
  let amount_2 = '0'
  let path_2 = ZERO_PATH
  let index_bits_2 = ZERO_BITS
  if (b) {
    const pb = await api.getNoteProof(desk.id, b.owner_tag)
    // Both paths must be against the same root (the circuit folds both to one).
    if (pa.root.toLowerCase() !== pb.root.toLowerCase()) {
      throw new Error('Tree advanced between path fetches; please retry.')
    }
    amount_2 = b.amount
    path_2 = pb.siblings
    index_bits_2 = pb.index_bits
  }

  // Sequential IMT-insert witnesses: nf1 (always), then nf2 (only for a real second input). The
  // circuit pins nullifier_2 == 0 when the second note is null.
  const real2 = !!b
  const nf2 = real2 ? terms.nullifier_2 : '0'
  onStatus?.('Fetching accumulator witnesses…')
  const wits = await api.getImtWitnesses(
    desk.id,
    real2 ? [terms.nullifier_1, terms.nullifier_2] : [terms.nullifier_1],
  )

  onStatus?.('Proving (UltraHonk, in-browser)…')
  const bundle = await proveJoin({
    sk_1: a.sk,
    rho_1: a.rho,
    nonce_1,
    amount_1: a.amount,
    path_1: pa.siblings,
    index_bits_1: pa.index_bits,
    imt_1: wits[0],
    sk_2,
    rho_2,
    nonce_2,
    amount_2,
    path_2,
    index_bits_2,
    imt_2: real2 ? wits[1] : ZERO_IMT,
    note_root: pa.root,
    nullifier_root_in: wits[0].nullifier_root_in,
    nullifier_root_out: real2 ? wits[1].nullifier_root_out : wits[0].nullifier_root_out,
    nullifier_1: terms.nullifier_1,
    nullifier_2: nf2,
    asset: a.asset_id,
    out_tag_1: terms.out_tag_1,
    out_amount_1: targetRaw.toString(),
    out_tag_2: terms.out_tag_2,
    out_amount_2: changeRaw.toString(),
  })

  let target: Note = {
    id: crypto.randomUUID(),
    deskId: desk.id,
    role: 'asset',
    asset_id: a.asset_id,
    symbol: a.symbol,
    amount: targetRaw.toString(),
    sk: sk_out1,
    rho: rho_out1,
    owner_tag: terms.out_tag_1,
    status: 'active',
    indexed: false,
    createdAt: Date.now(),
  }
  let change: Note | null =
    changeRaw > 0n
      ? {
          id: crypto.randomUUID(),
          deskId: desk.id,
          role: 'asset',
          asset_id: a.asset_id,
          symbol: a.symbol,
          amount: changeRaw.toString(),
          sk: sk_out2,
          rho: rho_out2,
          owner_tag: terms.out_tag_2,
          status: 'active',
          indexed: false,
          createdAt: Date.now(),
        }
      : null
  onStatus?.('Backing up output secrets…')
  const staged = await stageRecoverableNotes(change ? [target, change] : [target])
  target = staged[0]
  change = change ? staged[1] : null

  onStatus?.('Submitting (sponsored)…')
  await api.relayJoin(desk.id, b64(bundle.proof), b64(bundle.publicInputs))

  await updateNote(a.id, { status: 'spent' })
  if (b) await updateNote(b.id, { status: 'spent' })
  await syncRecoveryNow()
  return { target, change }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Poll the chain until the local note `noteId` is indexed (its leaf is available),
 * returning the updated note. Used between join steps so the next join can prove membership.
 */
export async function waitForConfirm(
  deskId: string,
  noteId: string,
  walletAddress?: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Note> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  const intervalMs = opts.intervalMs ?? 3_000
  const start = Date.now()
  for (;;) {
    try {
      const r = await api.getNotes(deskId)
      await reconcile(deskId, r.notes)
    } catch {
      /* transient; retry on the next tick */
    }
    const n = (await notesForDesk(deskId, walletAddress)).find((x) => x.id === noteId)
    if (n?.status === 'active' && n.indexed) return n
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for note confirmation.')
    await sleep(intervalMs)
  }
}

/**
 * Run an assembly plan to completion and return the single confirmed note of the exact target
 * amount. Steps (split / join) run in order; each is awaited on-chain before the next so its target
 * can be the next step's input. `notes` resolves the plan's original note references.
 */
export async function runAssembly(
  desk: Desk,
  steps: AssemblyStep[],
  notes: Note[],
  onStatus?: Status,
): Promise<Note> {
  const byId = new Map(notes.map((n) => [n.id, n]))
  const resolve = (ref: { type: 'note'; id: string } | { type: 'prev' }, prev: Note | null) =>
    ref.type === 'prev' ? prev : byId.get(ref.id) ?? null
  let prev: Note | null = null
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const a = resolve(s.a, prev)
    const b = s.op === 'join' ? resolve(s.b, prev) : null
    if (!a || (s.op === 'join' && !b)) throw new Error('A note is no longer available; please retry.')
    onStatus?.(`Preparing note — ${s.op} ${i + 1}/${steps.length}…`)
    const { target } = await executeJoin(desk, a, b, BigInt(s.targetRaw), BigInt(s.changeRaw), onStatus)
    onStatus?.(`Waiting for confirmation (${i + 1}/${steps.length})…`)
    prev = await waitForConfirm(desk.id, target.id, target.wallet_address)
  }
  if (!prev) throw new Error('Empty assembly plan.')
  return prev
}

// --- taker-side matching (WS4): settle a just-placed crossing order against resting makers ---

const ZERO_REMAINDER: MatchRemainder = {
  live: 0, asset_in: 0, amount_in: '0', asset_out: 0, min_out: '0',
  output_owner_tag: '0', cancel_owner_tag: '0', expiry: 0, partial_allowed: 0, order_leaf: '0',
}

/** Poll until `order_leaf` is indexed in the order tree (its membership path is derivable), so the
 * just-placed taker order can prove membership. Returns when ready; throws on timeout. */
async function waitForOrderIndexed(
  deskId: string,
  orderLeaf: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  const intervalMs = opts.intervalMs ?? 3_000
  const start = Date.now()
  for (;;) {
    try {
      await api.getOrderProof(deskId, orderLeaf)
      return
    } catch {
      /* not indexed yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for order indexing.')
    await sleep(intervalMs)
  }
}

/**
 * Prove + relay one `settle_match` that consumes the wallet's just-placed (taker) order against the
 * chosen makers, then record the taker's proceeds note and any re-rested remainder order. The taker
 * builds every output (proceeds tags fold the per-note match nonce `compress(taker_leaf, slot)`); the
 * circuit re-derives and asserts them. `order` is the order-output note place_order created.
 */
async function executeTakerMatch(
  desk: Desk,
  order: Note,
  plan: MatchSelection,
  now: number,
): Promise<void> {
  const c = order.cancel
  if (!c) return
  const symOf = (id: number) => desk.assets.find((a) => a.asset_id === id)?.symbol ?? `#${id}`

  // Membership paths: the taker first (fixes the order_root), then each maker against the same root.
  const takerProof = await api.getOrderProof(desk.id, c.order_leaf)
  const orderRoot = takerProof.order_root
  const makerProofs: OrderProof[] = []
  for (const m of plan.makers) {
    const mp = await api.getOrderProof(desk.id, m.order_leaf)
    if (mp.order_root.toLowerCase() !== orderRoot.toLowerCase()) {
      throw new Error('Order tree advanced between path fetches; resting instead.')
    }
    makerProofs.push(mp)
  }

  // Sequential consumption-nullifier IMT witnesses: taker, then makers (each against the prior root).
  const nfs = [takerProof.consumption_nullifier, ...makerProofs.map((p) => p.consumption_nullifier)]
  const wits = await api.getImtWitnesses(desk.id, nfs)

  // Per-note match nonces + folded proceeds tags (slot 0 = taker, 1.. = makers).
  const takerLeaf = c.order_leaf
  const nonce0 = await matchNonce(takerLeaf, 0)
  const takerTag = await proceedsTag(c.output_owner_tag, nonce0)
  const makerTags = await Promise.all(
    plan.makers.map(async (m, i) => proceedsTag(m.output_owner_tag, await matchNonce(takerLeaf, i + 1))),
  )

  const proceeds: MatchProceedsSlot[] = [
    { live: 1, asset: c.asset_out, amount: plan.totalOut.toString(), tag: takerTag },
    ...plan.makers.map((_, i) => ({
      live: 1, asset: c.asset_in, amount: plan.paid[i].toString(), tag: makerTags[i],
    })),
  ]
  while (proceeds.length < 4) proceeds.push({ live: 0, asset: 0, amount: '0', tag: '0' })

  // Remainder: re-rest the taker's leftover at its exact ratio under the taker's own tags + leaf.
  let remainder: MatchRemainder = ZERO_REMAINDER
  let remOrderLeaf = '0'
  if (plan.remainder > 0n) {
    const rem = await orderTerms({
      sk: order.sk, rho_in: order.rho, nonce_in: order.nonce ?? '0', rho_out: order.rho,
      rho_ord: c.rho_ord, asset_in: c.asset_in, amount_in: plan.remainder.toString(),
      asset_out: c.asset_out, min_out: plan.remMinOut.toString(), expiry: c.expiry,
      partial_allowed: c.partial_allowed ? 1 : 0,
    })
    remOrderLeaf = rem.order_leaf
    remainder = {
      live: 1, asset_in: c.asset_in, amount_in: plan.remainder.toString(), asset_out: c.asset_out,
      min_out: plan.remMinOut.toString(), output_owner_tag: c.output_owner_tag,
      cancel_owner_tag: c.cancel_owner_tag, expiry: c.expiry,
      partial_allowed: c.partial_allowed ? 1 : 0, order_leaf: remOrderLeaf,
    }
  }

  const nfMakers = makerProofs.map((p) => p.consumption_nullifier)
  while (nfMakers.length < 3) nfMakers.push('0')

  const takerW: MatchOrderWitness = {
    asset_in: c.asset_in, amount_in: c.amount_in, asset_out: c.asset_out, min_out: c.min_out,
    out_tag: c.output_owner_tag, cancel_tag: c.cancel_owner_tag, expiry: c.expiry,
    partial: c.partial_allowed ? 1 : 0, path: takerProof.siblings,
    index_bits: takerProof.index_bits, imt: wits[0],
  }
  const makersW: MatchOrderWitness[] = plan.makers.map((m, i) => ({
    asset_in: m.asset_in, amount_in: m.amount_in, asset_out: m.asset_out, min_out: m.min_out,
    out_tag: m.output_owner_tag, cancel_tag: m.cancel_owner_tag, expiry: m.expiry,
    partial: m.partial_allowed ? 1 : 0, path: makerProofs[i].siblings,
    index_bits: makerProofs[i].index_bits, imt: wits[i + 1],
  }))

  const bundle = await proveMatch({
    taker: takerW, makers: makersW, order_root: orderRoot,
    nullifier_root_in: wits[0].nullifier_root_in,
    nullifier_root_out: wits[wits.length - 1].nullifier_root_out,
    now, nf_taker: takerProof.consumption_nullifier, nf_makers: nfMakers, proceeds, remainder,
  })

  await api.relayMatch(desk.id, b64(bundle.proof), b64(bundle.publicInputs))

  // The placed order was consumed as the taker. We deliberately do NOT mint the taker's slot-0
  // proceeds note here: `discoverMatchedProceeds` recovers it uniformly (same path as a maker fill)
  // from the match's public events, keyed off this order's own `order_leaf`. That keeps exactly one
  // local note per consumed order (no duplicate vs. the discovery poll) and is crash-safe — a reload
  // after the relay still recovers the proceeds. We only stage the re-rested remainder, which is a
  // brand-new order the wallet alone knows the secrets for.
  if (plan.remainder > 0n) {
    await stageRecoverableNotes([
      {
        id: crypto.randomUUID(), deskId: desk.id, role: 'order-output', asset_id: c.asset_out,
        symbol: symOf(c.asset_out), amount: plan.remMinOut.toString(), sk: order.sk, rho: order.rho,
        owner_tag: c.output_owner_tag, status: 'active', indexed: false, createdAt: nowMs(),
        cancel: {
          rho_ord: c.rho_ord, order_leaf: remOrderLeaf, cancel_owner_tag: c.cancel_owner_tag,
          pairId: c.pairId, side: c.side, asset_in: c.asset_in, symbol_in: c.symbol_in,
          amount_in: plan.remainder.toString(), asset_out: c.asset_out,
          min_out: plan.remMinOut.toString(), output_owner_tag: c.output_owner_tag,
          expiry: c.expiry, partial_allowed: c.partial_allowed,
        },
      },
    ])
    await syncRecoveryNow()
  }
}

/**
 * Opportunistically settle a just-placed order in-browser if it crosses the resting book (the taker
 * path). Best-effort: any failure leaves the order resting on-chain (a valid outcome), so this never
 * throws — place_order has already succeeded by the time it runs.
 */
export async function maybeTakerMatch(desk: Desk, order: Note): Promise<void> {
  const c = order.cancel
  if (!c) return
  try {
    const taker: TakerTerms = {
      asset_in: c.asset_in, asset_out: c.asset_out, amount_in: BigInt(c.amount_in),
      min_out: BigInt(c.min_out), partial: c.partial_allowed,
    }
    // Backdate `now` slightly so it stays <= ledger time (the contract bounds now to recent ledger
    // time within a 300s skew); the circuit also asserts every matched order's expiry >= now.
    const now = nowSeconds() - 30
    const probe = await api.getBook(desk.id)
    if (!selectMatch(taker, probe.orders, now)) return // nothing crosses — just rest
    await waitForOrderIndexed(desk.id, c.order_leaf)
    const book = await api.getBook(desk.id)
    const plan = selectMatch(taker, book.orders, now)
    if (!plan) return
    await executeTakerMatch(desk, order, plan, now)
  } catch (e) {
    // Leave the order resting; a later (foreign) taker can still cross it.
    console.warn('taker auto-match skipped:', e instanceof Error ? e.message : e)
  }
}

/**
 * Discover proceeds a (possibly foreign) taker minted for the wallet's resting orders. A maker cannot
 * predict its proceeds tag — the matcher folds `nonce = compress(taker_leaf, slot)` it never sees —
 * so we ask the backend to recover both `nonce` and the folded `owner_tag` by correlating the match's
 * public events. A matched order-output note is rewritten into a spendable asset note (the on-chain
 * folded tag + nonce); the regular `reconcile` then stamps its leaf once `getNotes` sees it.
 * Returns true if anything changed. Best-effort: per-order failures are swallowed.
 */
export async function discoverMatchedProceeds(
  deskId: string,
  walletAddress?: string,
): Promise<boolean> {
  const notes = await notesForDesk(deskId, walletAddress)
  const resting = notes.filter((n) => n.status === 'active' && n.role === 'order-output' && n.cancel)
  let changed = false
  for (const n of resting) {
    try {
      const r = await api.getMatchProceeds(deskId, n.cancel!.order_leaf)
      if (!r.matched) continue
      await updateNote(n.id, {
        role: 'asset',
        nonce: r.nonce,
        owner_tag: r.owner_tag,
        amount: r.amount,
        indexed: false,
        cancel: undefined,
      })
      changed = true
    } catch {
      /* still resting, cancelled, or transient — retry next tick */
    }
  }
  return changed
}
