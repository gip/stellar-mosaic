import type { ClientAction, Desk, NoteProof, Operation, OperationRequest } from './api'
import { ApiError, api, withClientAction } from './api'
import { fieldToBytes32, randomField } from './crypto'
import { noteTag, orderTerms } from './noir'
import { notesForDesk, removeNote, updateNote, type Note } from './notes'
import { planAssembly } from './orderPlan'
import { executeUnshield, runAssembly, waitForConfirm } from './orchestrate'
import { b64, proveCancel, proveLift } from './prove'
import { stageRecoverableNote, syncRecoveryNow, updateNoteAndSync } from './recovery'
import { buildSponsoredShield } from './soroban'
import { nowMs, nowSeconds } from './time'
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk'
import { Buffer } from 'buffer'
import { submissionMode, submitContractCall, submitDirectOrSponsored } from './directTransaction'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const MODE = 'trusted' as const

/** The durable event indexer trails a successful transaction by a few seconds. Treat a missing
 * path as a readiness state, not as a failed order, and retry boundedly before proving. */
async function waitForNoteProof(
  deskId: string,
  ownerTag: string,
  timeoutMs = 30_000,
): Promise<NoteProof> {
  const started = Date.now()
  for (;;) {
    try {
      return await api.getNoteProof(MODE, deskId, ownerTag)
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error
      if (Date.now() - started >= timeoutMs) {
        throw new Error('The note is confirmed but its Merkle path is still indexing. Retry shortly.', {
          cause: error,
        })
      }
      await sleep(1_500)
    }
  }
}

/** Execute the private portion of one leased operation. Secrets and owned-note inventory never
 * enter the returned result; only the existing proof/XDR relay calls cross the boundary. */
export async function executeClientAction(action: ClientAction): Promise<Record<string, unknown>> {
  return withClientAction(action, async () => {
    const desk = await api.getDesk(MODE, action.payload.desk_id)
    switch (action.payload.kind) {
      case 'shield': return executeShield(desk, action.payload, action.operation_id)
      case 'place_order': return executeOrder(desk, action.payload, action.operation_id)
      case 'unshield': return executeUnshieldOperation(desk, action.payload, action.operation_id)
      case 'cancel_order': return executeCancel(desk, action.payload, action.operation_id)
    }
  })
}

/** Roll back only private pre-submission state. Committed join steps remain authoritative and can
 * be selected by a later operation after their outputs are indexed. */
export async function rollbackClientAction(action: ClientAction): Promise<void> {
  const address = (await api.getAuthSession()).address
  const notes = await notesForDesk(MODE, action.payload.desk_id, address)
  for (const note of notes.filter((item) => item.operation_id === action.operation_id)) {
    if (note.operation_state === 'reserved') {
      await updateNote(MODE, note.id, { operation_id: undefined, operation_state: undefined })
    } else if (note.operation_state === 'pending-output' && !note.indexed) {
      await removeNote(MODE, note.id)
    }
  }
  await syncRecoveryNow()
}

/** Finish or roll back journals after a reload. The backend's confirmed chain result is
 * authoritative, so a crash between relay success and local IndexedDB updates is recoverable. */
export async function reconcileOperationJournals(operations: Operation[], address: string) {
  let changed = false
  for (const deskId of new Set(operations.map((operation) => operation.desk_id))) {
    const deskOperations = new Map(operations.filter((operation) => operation.desk_id === deskId).map((operation) => [operation.id, operation]))
    for (const note of await notesForDesk(MODE, deskId, address)) {
      if (!note.operation_id || !note.operation_state || note.operation_state === 'committed') continue
      const operation = deskOperations.get(note.operation_id)
      if (!operation) continue
      if (operation.status === 'succeeded') {
        if (note.operation_state === 'reserved') {
          await updateNote(MODE, note.id, {
            status: operation.kind === 'cancel_order' ? 'cancelled' : 'spent',
            cancelledAt: operation.kind === 'cancel_order' ? nowMs() : note.cancelledAt,
            operation_state: 'committed',
          })
        } else {
          await updateNote(MODE, note.id, { operation_state: 'committed' })
        }
        changed = true
      } else if (operation.status === 'failed' || operation.status === 'cancelled') {
        if (note.operation_state === 'pending-output' && !note.indexed) await removeNote(MODE, note.id)
        else await updateNote(MODE, note.id, { operation_id: undefined, operation_state: undefined })
        changed = true
      }
    }
  }
  if (changed) await syncRecoveryNow()
}

async function executeShield(
  desk: Desk,
  request: Extract<OperationRequest, { kind: 'shield' }>,
  operationId: string,
) {
  const asset = desk.assets.find((a) => a.asset_id === request.asset_id)
  if (!asset) throw new Error('The requested asset is not registered on this desk.')
  const session = await api.getAuthSession()
  const sk = randomField(); const rho = randomField(); const owner_tag = await noteTag(sk, rho)
  const note: Note = {
    id: crypto.randomUUID(), deskId: desk.id, role: 'asset', asset_id: request.asset_id,
    symbol: asset.symbol, amount: request.amount, sk, rho, owner_tag, status: 'active', indexed: false,
    createdAt: nowMs(), operation_id: operationId, operation_state: 'pending-output',
  }
  await stageRecoverableNote(note, MODE)
  let transaction: string
  if (submissionMode() === 'direct') {
    transaction = await submitContractCall(desk.contract_id, 'shield', [
      new Address(session.address).toScVal(),
      nativeToScVal(request.asset_id, { type: 'u32' }),
      nativeToScVal(BigInt(request.amount), { type: 'i128' }),
      xdr.ScVal.scvBytes(Buffer.from(fieldToBytes32(owner_tag))),
    ])
  } else {
    const txXdr = await buildSponsoredShield(
      desk.contract_id, desk.sponsor_pubkey, session.address, request.asset_id, request.amount,
      fieldToBytes32(owner_tag),
    )
    transaction = (await api.submitShield(desk.id, txXdr)).result
  }
  // Transaction success does not mean the path server has ingested the new leaf yet. Keep the note
  // unspendable until reconciliation observes the actual event, preventing an immediate order from
  // requesting a membership path that cannot exist locally yet.
  await updateNoteAndSync(note.id, { txHash: transaction, operation_state: 'committed' }, MODE)
  let indexed = false
  try {
    await waitForConfirm(MODE, desk.id, note.id, session.address, { timeoutMs: 30_000, intervalMs: 1_500 })
    await syncRecoveryNow()
    indexed = true
  } catch {
    // The shield is already final. Leave it visibly pending; the desk poller continues reconciling.
  }
  return { transaction, indexed }
}

async function exactInput(desk: Desk, assetId: number, amount: bigint): Promise<Note> {
  const notes = await notesForDesk(MODE, desk.id, (await api.getAuthSession()).address)
  const plan = planAssembly(notes, assetId, amount)
  if (plan.kind === 'impossible') throw new Error(plan.reason)
  if (plan.kind === 'direct') {
    const note = notes.find((n) => n.id === plan.noteId)
    if (!note) throw new Error('The selected private note is no longer available.')
    return note
  }
  return runAssembly(MODE, desk, plan.steps, notes)
}

async function executeOrder(
  desk: Desk,
  request: Extract<OperationRequest, { kind: 'place_order' }>,
  operationId: string,
) {
  const pair = desk.pairs.find((p) => p.pair_id === request.pair_id)
  if (!pair) throw new Error('The requested pair is not registered on this desk.')
  const assetIn = request.side === 'SELL' ? pair.base_asset : pair.quote_asset
  const assetOut = request.side === 'SELL' ? pair.quote_asset : pair.base_asset
  const base = desk.assets.find((a) => a.asset_id === pair.base_asset)
  const quote = desk.assets.find((a) => a.asset_id === pair.quote_asset)
  const offer = await exactInput(desk, assetIn, BigInt(request.amount_in))
  const membership = await waitForNoteProof(desk.id, offer.owner_tag)
  await updateNote(MODE, offer.id, { operation_id: operationId, operation_state: 'reserved' })

  const expiry = nowSeconds() + 7 * 86400
  const rho_out = randomField(); const rho_ord = randomField()
  const terms = await orderTerms({
    sk: offer.sk, rho_in: offer.rho, rho_out, rho_ord, asset_in: assetIn,
    amount_in: offer.amount, asset_out: assetOut, min_out: request.min_out, expiry,
    partial_allowed: request.partial_allowed ? 1 : 0,
  })
  const bundle = await proveLift({
    rho_in: offer.rho, sk_o: offer.sk, path: membership.siblings,
    index_bits: membership.index_bits, root: membership.root,
    nullifier_in: terms.nullifier_in, asset_in: assetIn, amount_in: offer.amount,
    asset_out: assetOut, min_out: request.min_out, output_owner_tag: terms.output_owner_tag,
    cancel_owner_tag: terms.cancel_owner_tag, expiry,
    partial_allowed: request.partial_allowed ? 1 : 0, order_leaf: terms.order_leaf,
  })
  const symbol = desk.assets.find((a) => a.asset_id === assetOut)?.symbol ?? `#${assetOut}`
  const output: Note = {
    id: crypto.randomUUID(), deskId: desk.id, role: 'order-output', asset_id: assetOut,
    symbol, amount: request.min_out, sk: offer.sk, rho: rho_out, owner_tag: terms.output_owner_tag,
    status: 'active', indexed: false, createdAt: nowMs(), operation_id: operationId,
    operation_state: 'pending-output', cancel: {
      rho_ord, order_leaf: terms.order_leaf, cancel_owner_tag: terms.cancel_owner_tag,
      pairId: request.pair_id, side: request.side === 'SELL' ? 1 : 0,
      asset_in: assetIn,
      symbol_in: desk.assets.find((a) => a.asset_id === assetIn)?.symbol ?? `#${assetIn}`,
      amount_in: offer.amount,
    },
  }
  await stageRecoverableNote(output, MODE)
  await submitDirectOrSponsored(
    desk.contract_id,
    'submit_order',
    [
      xdr.ScVal.scvBytes(Buffer.from(bundle.proof)),
      xdr.ScVal.scvBytes(Buffer.from(bundle.publicInputs)),
    ],
    () => api.relayOrder(desk.id, b64(bundle.proof), b64(bundle.publicInputs)),
  )
  await updateNote(MODE, offer.id, { status: 'spent', operation_state: 'committed' })
  await updateNote(MODE, output.id, { operation_state: 'committed' })
  await syncRecoveryNow()
  return {
    output_tag: terms.output_owner_tag,
    pair_id: request.pair_id,
    side: request.side,
    base_symbol: base?.symbol ?? `#${pair.base_asset}`,
    quote_symbol: quote?.symbol ?? `#${pair.quote_asset}`,
    base_decimals: base?.decimals ?? 7,
    quote_decimals: quote?.decimals ?? 7,
    asset_in: assetIn,
    symbol_in: desk.assets.find((a) => a.asset_id === assetIn)?.symbol ?? `#${assetIn}`,
    amount_in: offer.amount,
    asset_out: assetOut,
    symbol_out: symbol,
    min_out: request.min_out,
    partial_allowed: request.partial_allowed,
  }
}

async function executeUnshieldOperation(
  desk: Desk,
  request: Extract<OperationRequest, { kind: 'unshield' }>,
  operationId: string,
) {
  const note = await exactInput(desk, request.asset_id, BigInt(request.amount))
  await updateNote(MODE, note.id, { operation_id: operationId, operation_state: 'reserved' })
  await executeUnshield(MODE, desk, note, request.recipient)
  await updateNote(MODE, note.id, { operation_state: 'committed' })
  await syncRecoveryNow()
  return {
    recipient: request.recipient,
    asset_id: request.asset_id,
    symbol: desk.assets.find((a) => a.asset_id === request.asset_id)?.symbol ?? `#${request.asset_id}`,
    amount: request.amount,
  }
}

async function executeCancel(
  desk: Desk,
  request: Extract<OperationRequest, { kind: 'cancel_order' }>,
  operationId: string,
) {
  const notes = await notesForDesk(MODE, desk.id, (await api.getAuthSession()).address)
  const note = notes.find((n) => n.id === request.wallet_note_id)
  const c = note?.cancel
  if (!note || !c || note.status !== 'active') throw new Error('The order is no longer cancellable.')
  await updateNote(MODE, note.id, { operation_id: operationId, operation_state: 'reserved' })
  const rho_return = randomField(); const return_owner_tag = await noteTag(note.sk, rho_return)
  const bundle = await proveCancel({ sk_o: note.sk, rho_ord: c.rho_ord, order_leaf: c.order_leaf, cancel_owner_tag: c.cancel_owner_tag, return_owner_tag })
  const refund: Note = {
    id: crypto.randomUUID(), deskId: desk.id, role: 'asset', asset_id: c.asset_in,
    symbol: c.symbol_in, amount: c.amount_in, sk: note.sk, rho: rho_return, owner_tag: return_owner_tag,
    status: 'active', indexed: false, createdAt: nowMs(), operation_id: operationId,
    operation_state: 'pending-output',
  }
  await stageRecoverableNote(refund, MODE)
  await submitDirectOrSponsored(
    desk.contract_id,
    'cancel_order',
    [
      nativeToScVal(c.pairId, { type: 'u32' }),
      nativeToScVal(c.side, { type: 'u32' }),
      xdr.ScVal.scvBytes(Buffer.from(bundle.proof)),
      xdr.ScVal.scvBytes(Buffer.from(bundle.publicInputs)),
    ],
    () => api.relayCancel(desk.id, c.pairId, c.side, b64(bundle.proof), b64(bundle.publicInputs)),
  )
  await updateNote(MODE, note.id, { status: 'cancelled', cancelledAt: nowMs(), operation_state: 'committed' })
  await updateNote(MODE, refund.id, { operation_state: 'committed' })
  await syncRecoveryNow()
  return {
    return_owner_tag,
    cancelled_note_id: note.id,
    pair_id: c.pairId,
    side: c.side,
    refund_asset_id: c.asset_in,
    refund_symbol: c.symbol_in,
    refund_amount: c.amount_in,
  }
}
