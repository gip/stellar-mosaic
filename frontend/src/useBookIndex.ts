import { useCallback, useEffect, useState } from 'react'
import { Networks } from '@stellar/stellar-sdk'
import { errorMessage } from '@mosaic/sdk'
import type { Desk } from './api'
import { clearBookIndex, syncBookIndex, syncTrustedBookIndex, type BookIndexSnapshot } from './bookIndexer'
import type { StorageMode } from './StorageModeContext'

const EMPTY: BookIndexSnapshot = {
  status: 'syncing',
  lastLedger: 0,
  lastSequence: '0',
  targetSequence: '0',
  orders: [],
  assets: [],
  pairs: [],
}

function failedSnapshot(desk: Desk, scope: string, error: unknown): BookIndexSnapshot {
  return {
    status: 'error',
    error: errorMessage(error),
    lastLedger: 0,
    lastSequence: '0',
    targetSequence: '0',
    orders: [],
    assets: desk.assets.map((asset) => ({
      id: `${scope}\u0000${asset.asset_id}`,
      scope,
      asset_id: asset.asset_id,
      token: asset.token ?? '',
      kind: asset.kind,
    })),
    pairs: desk.pairs.map((pair) => ({
      id: `${scope}\u0000${pair.pair_id}`,
      scope,
      pair_id: pair.pair_id,
      base_asset: pair.base_asset,
      quote_asset: pair.quote_asset,
    })),
  }
}

export interface BookIndexState extends BookIndexSnapshot {
  recheck: () => Promise<void>
}

export function useBookIndex(mode: StorageMode, desk: Desk | null, networkPassphrase: string | null): BookIndexState {
  const network = networkPassphrase ?? Networks.TESTNET
  const scope = desk ? `${mode}\u0000${network}\u0000${desk.contract_id}` : ''
  const [stored, setStored] = useState<{ scope: string; snapshot: BookIndexSnapshot }>({
    scope: '',
    snapshot: EMPTY,
  })
  const [generation, setGeneration] = useState(0)
  const state = stored.scope === scope ? stored.snapshot : EMPTY
  const recheck = useCallback(async () => {
    if (!desk) return
    await clearBookIndex(mode, desk, network)
    setStored({ scope, snapshot: EMPTY })
    setGeneration((value) => value + 1)
  }, [mode, desk, network, scope])

  useEffect(() => {
    if (!desk) return
    let alive = true
    let running = false
    const tick = async () => {
      if (running) return
      running = true
      try {
        const next = mode === 'trusted'
          ? await syncTrustedBookIndex(desk, network)
          : await syncBookIndex(
            mode,
            desk,
            desk.sponsor_pubkey,
            network,
            desk.event_start_ledger,
        )
        if (alive) setStored({ scope, snapshot: next })
      } catch (error) {
        if (alive) setStored({ scope, snapshot: failedSnapshot(desk, scope, error) })
      } finally {
        running = false
      }
    }
    void tick()
    const interval = window.setInterval(() => void tick(), 3000)
    return () => {
      alive = false
      window.clearInterval(interval)
    }
  }, [mode, desk, network, generation, scope])
  return { ...state, recheck }
}
