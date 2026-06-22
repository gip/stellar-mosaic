import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type CatalogAsset } from '../api'

interface PairRow {
  base: string
  quote: string
}

/**
 * Create a brand-new desk: the backend deploys a fresh settlement contract, funds a sponsor
 * ("main") account, and registers the chosen assets + pairs. Deploy takes ~30-60s on testnet.
 *
 * Assets are chosen from the catalog, restricted to ones the current user trusts (the built-in
 * defaults are always trusted). New assets are proposed and trusted on the Assets page.
 */
export default function CreateDeskForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [catalog, setCatalog] = useState<CatalogAsset[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [pairs, setPairs] = useState<PairRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    api
      // Desks are Stellar settlement contracts, so only assets with a Stellar side are selectable.
      .listCatalogAssets()
      .then((all) => active && setCatalog(all.filter((a) => a.trusted_by_me && a.stellar_token)))
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      active = false
    }
  }, [])

  // Selected catalog entries become desk assets, with asset_id assigned by selection order (1-based).
  const chosen = selected
    .map((id) => catalog?.find((a) => a.id === id))
    .filter((a): a is CatalogAsset => !!a)
  const assetIdOf = (catalogId: string) => selected.indexOf(catalogId) + 1

  function toggleAsset(id: string) {
    const removing = selected.includes(id)
    const next = removing ? selected.filter((x) => x !== id) : [...selected, id]
    setSelected(next)
    if (removing) {
      // A removed asset can no longer be referenced by a pair.
      setPairs((prev) => prev.filter((p) => p.base !== id && p.quote !== id))
    } else if (next.length === 2 && pairs.length === 0) {
      // Seed an initial pair so the desk is tradable by default (at least one pair is required).
      setPairs([{ base: next[0], quote: next[1] }])
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const assets = chosen.map((a) => ({
        asset_id: assetIdOf(a.id),
        symbol: a.symbol,
        token: a.stellar_token ?? 'native',
        decimals: a.stellar_decimals ?? 7,
      }))
      const deskPairs = pairs
        .filter((p) => p.base && p.quote && p.base !== p.quote)
        .map((p) => ({ base_asset: assetIdOf(p.base), quote_asset: assetIdOf(p.quote) }))
      if (assets.length === 0) throw new Error('Select at least one asset.')
      if (assets.length >= 2 && deskPairs.length === 0)
        throw new Error('Add at least one trading pair (base / quote).')
      await api.createDesk({ name, assets, pairs: deskPairs })
      setName('')
      setSelected([])
      setPairs([])
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

      <label>Assets — choose from the assets you trust</label>
      {catalog === null && <p className="muted">Loading…</p>}
      {catalog?.length === 0 && (
        <p className="muted">
          No trusted assets. Add or trust one on the <Link to="/assets">Assets</Link> page.
        </p>
      )}
      {catalog?.map((a) => (
        <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' }}>
          <input
            type="checkbox"
            checked={selected.includes(a.id)}
            onChange={() => toggleAsset(a.id)}
          />
          <span>
            {a.symbol}
            {selected.includes(a.id) && <span className="muted"> · asset_id {assetIdOf(a.id)}</span>}
          </span>
        </label>
      ))}

      {chosen.length >= 2 && (
        <>
          <label>Pairs — base / quote (at least one required)</label>
          {pairs.map((p, i) => (
            <div className="row" key={i} style={{ alignItems: 'center', marginBottom: 6 }}>
              <select
                value={p.base}
                onChange={(e) =>
                  setPairs((prev) => prev.map((x, j) => (j === i ? { ...x, base: e.target.value } : x)))
                }
              >
                <option value="">base…</option>
                {chosen.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.symbol}
                  </option>
                ))}
              </select>
              <select
                value={p.quote}
                onChange={(e) =>
                  setPairs((prev) => prev.map((x, j) => (j === i ? { ...x, quote: e.target.value } : x)))
                }
              >
                <option value="">quote…</option>
                {chosen.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.symbol}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => setPairs((prev) => prev.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          <p>
            <button type="button" onClick={() => setPairs((prev) => [...prev, { base: '', quote: '' }])}>
              Add pair
            </button>
          </p>
        </>
      )}

      {error && <p className="err">{error}</p>}
      <p>
        <button type="submit" disabled={busy}>
          {busy ? 'Deploying… (~1 min)' : 'Create desk'}
        </button>
      </p>
    </form>
  )
}
