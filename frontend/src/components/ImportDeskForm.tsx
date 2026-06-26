import { useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { api } from '../api'

const ASSETS_TEMPLATE = `[
  { "asset_id": 1, "symbol": "XLM",  "token": "C...", "decimals": 7 },
  { "asset_id": 2, "symbol": "USDC", "token": "C...", "decimals": 7 }
]`
const PAIRS_TEMPLATE = `[
  { "pair_id": 0, "base_asset": 1, "quote_asset": 2 }
]`

/**
 * Phase-1 convenience: register an already-deployed settlement contract as a (read-only) desk.
 * Phase 2 replaces this with a real "Create desk" flow that deploys a fresh contract.
 */
export default function ImportDeskForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [contractId, setContractId] = useState('')
  const [sponsor, setSponsor] = useState('')
  const [assets, setAssets] = useState(ASSETS_TEMPLATE)
  const [pairs, setPairs] = useState(PAIRS_TEMPLATE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.importDesk({
        name,
        contract_id: contractId.trim(),
        sponsor_pubkey: sponsor.trim(),
        assets: JSON.parse(assets),
        pairs: JSON.parse(pairs),
      })
      setName('')
      setContractId('')
      setSponsor('')
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 560 }}>
      <label>Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} required style={{ width: '100%' }} />
      <label>Contract id (C…)</label>
      <input
        className="mono"
        value={contractId}
        onChange={(e) => setContractId(e.target.value)}
        required
        style={{ width: '100%' }}
      />
      <label>Sponsor / source account (G…) — used for read simulations</label>
      <input
        className="mono"
        value={sponsor}
        onChange={(e) => setSponsor(e.target.value)}
        style={{ width: '100%' }}
      />
      <label>Assets (JSON)</label>
      <textarea
        className="mono"
        value={assets}
        onChange={(e) => setAssets(e.target.value)}
        rows={5}
        style={{ width: '100%' }}
      />
      <label>Pairs (JSON)</label>
      <textarea
        className="mono"
        value={pairs}
        onChange={(e) => setPairs(e.target.value)}
        rows={3}
        style={{ width: '100%' }}
      />
      {error && <p className="err">{error}</p>}
      <p>
        <button type="submit" disabled={busy}>
          {busy ? 'Importing…' : 'Import desk'}
        </button>
      </p>
    </form>
  )
}
