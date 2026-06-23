// Async execution of the note-assembly plan from orderPlan.ts. This is the single code path for
// proving + relaying a `join` and for driving a multi-join sequence:
// each join's outputs are unindexed until they land on-chain and reconcile, and the next join needs
// its input's membership proof, so the steps are inherently sequential and gated on confirmation.
import type { Desk } from './api'
import { api } from './api'
import { randomField } from './crypto'
import { joinTerms, noteNullifier } from './noir'
import { proveJoin, proveUnshield, b64 } from './prove'
import { recipientField } from './soroban'
import { updateNote, notesForDesk, reconcile, type Note } from './notes'
import type { AssemblyStep } from './orderPlan'
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

  onStatus?.('Proving (UltraHonk, in-browser)…')
  const bundle = await proveJoin({
    sk_1: a.sk,
    rho_1: a.rho,
    amount_1: a.amount,
    path_1: pa.siblings,
    index_bits_1: pa.index_bits,
    sk_2,
    rho_2,
    amount_2,
    path_2,
    index_bits_2,
    root: pa.root,
    nullifier_1: terms.nullifier_1,
    nullifier_2: terms.nullifier_2,
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
