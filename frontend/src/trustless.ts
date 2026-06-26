import { Networks } from '@stellar/stellar-sdk'
import { createBrowserClient } from '@mosaic/sdk/browser'
import type { Desk } from './api'
import type { Note } from './notes'
import { SOROBAN_RPC_URL } from './bookIndexer'
import { FreighterSigner } from './sdk/freighterSigner'
import { IndexedDbStore } from './sdk/indexedDbStore'
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

export async function shieldTrustless(
  desk: Desk,
  params: { address: string; assetId: number; amount: string },
): Promise<Note> {
  const { client } = createBrowserClient({
    network: { rpcUrl: SOROBAN_RPC_URL, networkPassphrase: Networks.TESTNET },
    signer: new FreighterSigner(params.address),
    store: new IndexedDbStore(),
    desks: [deskConfig(desk)],
    startLedger: desk.event_start_ledger ?? 0,
    prepareNotes: stageRecoverableNotes,
    initNoir: initNoirWasm,
  })
  const { note } = await client.shield({
    deskId: desk.id,
    asset_id: params.assetId,
    amount: params.amount,
  })
  await syncRecoveryNow()
  return note as Note
}
