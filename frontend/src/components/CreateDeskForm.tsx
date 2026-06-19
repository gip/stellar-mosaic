import { useState } from 'react'
import { api } from '../api'

const ASSETS_TEMPLATE = `[
  { "asset_id": 1, "symbol": "XLM",  "token": "native", "decimals": 7 },
  { "asset_id": 2, "symbol": "USDC", "token": "native", "decimals": 7 }
]`
const PAIRS_TEMPLATE = `[
  { "base_asset": 1, "quote_asset": 2 }
]`

/**
 * Create a brand-new desk: the backend deploys a fresh settlement contract, funds a sponsor
 * ("main") account, and registers the assets + pairs. Token "native" resolves to the XLM SAC.
 * Deploy takes ~30-60s on testnet.
 */
export default function CreateDeskForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [assets, setAssets] = useState(ASSETS_TEMPLATE)
  const [pairs, setPairs] = useState(PAIRS_TEMPLATE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.createDesk({ name, assets: JSON.parse(assets), pairs: JSON.parse(pairs) })
      setName('')
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 560 }}>
      <label>Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} required style={{ width: '100%' }} />
      <label>Assets (JSON) — token "native" = XLM SAC</label>
      <textarea
        className="mono"
        value={assets}
        onChange={(e) => setAssets(e.target.value)}
        rows={5}
        style={{ width: '100%' }}
      />
      <label>Pairs (JSON) — canonical base/quote; pair_id assigned on register</label>
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
          {busy ? 'Deploying… (~1 min)' : 'Create desk'}
        </button>
      </p>
    </form>
  )
}
