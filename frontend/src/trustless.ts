import { Networks } from '@stellar/stellar-sdk'
import { createBrowserClient } from '@mosaic/sdk/browser'
import type { Desk } from './api'
import type { Note } from './notes'
import { SOROBAN_RPC_URL } from './config'
import { FreighterSigner } from './sdk/freighterSigner'
import { browserActivityStore, IndexedDbStore } from './sdk/indexedDbStore'
import { stageRecoverableNotes, syncRecoveryNow } from './recovery'
import { initNoirWasm } from './noirWasm'

function deskConfig(desk: Desk) {
  return {
    id: desk.id,
    name: desk.name,
    contractId: desk.contract_id,
    sponsor: desk.sponsor_pubkey,
    assets: desk.assets.map((asset) => ({
      asset_id: asset.asset_id,
      symbol: asset.symbol,
      token: asset.kind === 'BaseRepresented' ? null : asset.token,
      decimals: asset.decimals,
      kind: asset.kind,
    })),
    pairs: desk.pairs,
  }
}

function trustlessClient(desk: Desk, address: string) {
  return createBrowserClient({
    network: { rpcUrl: SOROBAN_RPC_URL, networkPassphrase: Networks.TESTNET },
    signer: new FreighterSigner(address),
    store: new IndexedDbStore(),
    activity: browserActivityStore,
    desks: [deskConfig(desk)],
    startLedger: desk.event_start_ledger ?? 0,
    prepareNotes: stageRecoverableNotes,
    initNoir: initNoirWasm,
    // No persistent eventCache here: this client is created fresh per operation and only needs to
    // confirm its own note within waitForConfirm. Sharing the long-lived reconcile source's cache
    // scope (keyed by passphrase+contractId) let the two clobber each other's cursor across reads.
  }).client
}

export async function shieldTrustless(
  desk: Desk,
  params: { address: string; assetId: number; amount: string },
): Promise<Note> {
  const { note } = await trustlessClient(desk, params.address).shield({
    deskId: desk.id,
    asset_id: params.assetId,
    amount: params.amount,
  })
  await syncRecoveryNow()
  return note as Note
}

export async function placeOrderTrustless(
  desk: Desk,
  params: {
    address: string
    pairId: number
    side: 0 | 1
    amountIn: string
    minOut: string
    partialAllowed: boolean
  },
): Promise<Note> {
  const { note } = await trustlessClient(desk, params.address).placeOrder({
    deskId: desk.id,
    pairId: params.pairId,
    side: params.side,
    amountIn: params.amountIn,
    minOut: params.minOut,
    partialAllowed: params.partialAllowed,
  })
  await syncRecoveryNow()
  return note as Note
}

export async function unshieldTrustless(
  desk: Desk,
  params: { address: string; assetId: number; amount: string; recipient: string },
): Promise<void> {
  await trustlessClient(desk, params.address).unshield({
    deskId: desk.id,
    asset_id: params.assetId,
    amount: params.amount,
    recipient: params.recipient,
  })
  await syncRecoveryNow()
}

export async function cancelOrderTrustless(
  desk: Desk,
  params: { address: string; noteId: string },
): Promise<Note> {
  const { note } = await trustlessClient(desk, params.address).cancelOrder({
    deskId: desk.id,
    noteId: params.noteId,
  })
  await syncRecoveryNow()
  return note as Note
}
