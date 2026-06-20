import type { ClientAction, Desk, Operation, OperationRequest } from './api'
import { api, withClientAction } from './api'
import { fieldToBytes32, randomField } from './crypto'
import { noteTag, orderTerms } from './noir'
import { notesForDesk, removeNote, updateNote, type Note } from './notes'
import { planAssembly } from './orderPlan'
import { executeUnshield, runAssembly } from './orchestrate'
import { b64, proveCancel, proveLift } from './prove'
import { stageRecoverableNote, syncRecoveryNow, updateNoteAndSync } from './recovery'
import { buildSponsoredShield } from './soroban'
import { nowMs, nowSeconds } from './time'

/** Execute the private portion of one leased operation. Secrets and owned-note inventory never
 * enter the returned result; only the existing proof/XDR relay calls cross the boundary. */
export async function executeClientAction(action: ClientAction): Promise<Record<string, unknown>> {
  return withClientAction(action, async () => {
    const desk = await api.getDesk(action.payload.desk_id)
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
  const notes = await notesForDesk(action.payload.desk_id, address)
  for (const note of notes.filter((item) => item.operation_id === action.operation_id)) {
    if (note.operation_state === 'reserved') {
      await updateNote(note.id, { operation_id: undefined, operation_state: undefined })
    } else if (note.operation_state === 'pending-output' && !note.indexed) {
      await removeNote(note.id)
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
    for (const note of await notesForDesk(deskId, address)) {
      if (!note.operation_id || !note.operation_state || note.operation_state === 'committed') continue
      const operation = deskOperations.get(note.operation_id)
      if (!operation) continue
      if (operation.status === 'succeeded') {
        if (note.operation_state === 'reserved') {
          await updateNote(note.id, {
            status: operation.kind === 'cancel_order' ? 'cancelled' : 'spent',
            cancelledAt: operation.kind === 'cancel_order' ? nowMs() : note.cancelledAt,
            operation_state: 'committed',
          })
        } else {
          await updateNote(note.id, { operation_state: 'committed' })
        }
        changed = true
      } else if (operation.status === 'failed' || operation.status === 'cancelled') {
        if (note.operation_state === 'pending-output' && !note.indexed) await removeNote(note.id)
        else await updateNote(note.id, { operation_id: undefined, operation_state: undefined })
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
  const txXdr = await buildSponsoredShield(
    desk.contract_id, desk.sponsor_pubkey, session.address, request.asset_id, request.amount,
    fieldToBytes32(owner_tag),
  )
  const note: Note = {
    id: crypto.randomUUID(), deskId: desk.id, role: 'asset', asset_id: request.asset_id,
    symbol: asset.symbol, amount: request.amount, sk, rho, owner_tag, status: 'active', indexed: false,
    createdAt: nowMs(), operation_id: operationId, operation_state: 'pending-output',
  }
  await stageRecoverableNote(note)
  const { result } = await api.submitShield(desk.id, txXdr)
  await updateNoteAndSync(note.id, { indexed: true, txHash: result, operation_state: 'committed' })
  return { transaction: result }
}

async function exactInput(desk: Desk, assetId: number, amount: bigint): Promise<Note> {
  const notes = await notesForDesk(desk.id, (await api.getAuthSession()).address)
  const plan = planAssembly(notes, assetId, amount)
  if (plan.kind === 'impossible') throw new Error(plan.reason)
  if (plan.kind === 'direct') {
    const note = notes.find((n) => n.id === plan.noteId)
    if (!note) throw new Error('The selected private note is no longer available.')
    return note
  }
  return runAssembly(desk, plan.steps, notes)
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
  const offer = await exactInput(desk, assetIn, BigInt(request.amount_in))
  await updateNote(offer.id, { operation_id: operationId, operation_state: 'reserved' })

  const expiry = nowSeconds() + 7 * 86400
  const rho_out = randomField(); const rho_ord = randomField()
  const terms = await orderTerms({
    sk: offer.sk, rho_in: offer.rho, rho_out, rho_ord, asset_in: assetIn,
    amount_in: offer.amount, asset_out: assetOut, min_out: request.min_out, expiry,
    partial_allowed: request.partial_allowed ? 1 : 0,
  })
  const membership = await api.getNoteProof(desk.id, offer.owner_tag)
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
  await stageRecoverableNote(output)
  await api.relayOrder(desk.id, b64(bundle.proof), b64(bundle.publicInputs))
  await updateNote(offer.id, { status: 'spent', operation_state: 'committed' })
  await updateNote(output.id, { operation_state: 'committed' })
  await syncRecoveryNow()
  return { output_tag: terms.output_owner_tag }
}

async function executeUnshieldOperation(
  desk: Desk,
  request: Extract<OperationRequest, { kind: 'unshield' }>,
  operationId: string,
) {
  const note = await exactInput(desk, request.asset_id, BigInt(request.amount))
  await updateNote(note.id, { operation_id: operationId, operation_state: 'reserved' })
  await executeUnshield(desk, note, request.recipient)
  await updateNote(note.id, { operation_state: 'committed' })
  await syncRecoveryNow()
  return { recipient: request.recipient }
}

async function executeCancel(
  desk: Desk,
  request: Extract<OperationRequest, { kind: 'cancel_order' }>,
  operationId: string,
) {
  const notes = await notesForDesk(desk.id, (await api.getAuthSession()).address)
  const note = notes.find((n) => n.id === request.wallet_note_id)
  const c = note?.cancel
  if (!note || !c || note.status !== 'active') throw new Error('The order is no longer cancellable.')
  await updateNote(note.id, { operation_id: operationId, operation_state: 'reserved' })
  const rho_return = randomField(); const return_owner_tag = await noteTag(note.sk, rho_return)
  const bundle = await proveCancel({ sk_o: note.sk, rho_ord: c.rho_ord, order_leaf: c.order_leaf, cancel_owner_tag: c.cancel_owner_tag, return_owner_tag })
  const refund: Note = {
    id: crypto.randomUUID(), deskId: desk.id, role: 'asset', asset_id: c.asset_in,
    symbol: c.symbol_in, amount: c.amount_in, sk: note.sk, rho: rho_return, owner_tag: return_owner_tag,
    status: 'active', indexed: false, createdAt: nowMs(), operation_id: operationId,
    operation_state: 'pending-output',
  }
  await stageRecoverableNote(refund)
  await api.relayCancel(desk.id, c.pairId, c.side, b64(bundle.proof), b64(bundle.publicInputs))
  await updateNote(note.id, { status: 'cancelled', cancelledAt: nowMs(), operation_state: 'committed' })
  await updateNote(refund.id, { operation_state: 'committed' })
  await syncRecoveryNow()
  return { return_owner_tag }
}
