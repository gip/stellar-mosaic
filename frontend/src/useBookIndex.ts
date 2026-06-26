import { useCallback, useEffect, useState } from 'react'
import { Networks } from '@stellar/stellar-sdk'
import type { Desk } from './api'
import { clearBookIndex, syncBookIndex, type BookIndexSnapshot } from './bookIndexer'

const EMPTY: BookIndexSnapshot = {
  status: 'syncing',
  lastLedger: 0,
  lastSequence: '0',
  targetSequence: '0',
  orders: [],
  assets: [],
  pairs: [],
}

export interface BookIndexState extends BookIndexSnapshot {
  recheck: () => Promise<void>
}

export function useBookIndex(desk: Desk | null, networkPassphrase: string | null): BookIndexState {
  const network = networkPassphrase ?? Networks.TESTNET
  const scope = desk ? `${network}\u0000${desk.contract_id}` : ''
  const [stored, setStored] = useState<{ scope: string; snapshot: BookIndexSnapshot }>({
    scope: '',
    snapshot: EMPTY,
  })
  const [generation, setGeneration] = useState(0)
  const state = stored.scope === scope ? stored.snapshot : EMPTY
  const recheck = useCallback(async () => {
    if (!desk) return
    await clearBookIndex(desk, network)
    setStored({ scope, snapshot: EMPTY })
    setGeneration((value) => value + 1)
  }, [desk, network, scope])

  useEffect(() => {
    if (!desk) return
    let alive = true
    let running = false
    const tick = async () => {
      if (running) return
      running = true
      try {
        const next = await syncBookIndex(
          desk,
          desk.sponsor_pubkey,
          network,
          desk.event_start_ledger,
        )
        if (alive) setStored({ scope, snapshot: next })
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
  }, [desk, network, generation, scope])
  return { ...state, recheck }
}
