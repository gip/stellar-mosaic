import { useCallback, useEffect, useMemo, useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { Link } from 'react-router-dom'
import { api, type BaseDeploymentConfig, type CatalogAsset, type Desk } from '../api'
import { useEthereumWallet } from '../EthereumWalletContext'
import { displayEth, estimateBridgeDeployment } from '../base'
import type { Address } from 'viem'
import BaseDeploymentPanel from './BaseDeploymentPanel'
import { assetKindOf, baseTokenAddress, eligibleBaseAssets, hasEnoughEth } from '../baseDeployment'
import type { StorageMode } from '../StorageModeContext'

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
export default function CreateDeskForm({
  mode,
  onDone,
  allowSponsored = true,
}: {
  mode: StorageMode
  onDone: () => void
  allowSponsored?: boolean
}) {
  const [name, setName] = useState('')
  const [catalog, setCatalog] = useState<CatalogAsset[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [pairs, setPairs] = useState<PairRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deployBase, setDeployBase] = useState(false)
  const [deploymentConfig, setDeploymentConfig] = useState<BaseDeploymentConfig | null>(null)
  const [estimatedFee, setEstimatedFee] = useState<bigint | null>(null)
  const [createdDesk, setCreatedDesk] = useState<Desk | null>(null)
  const [stellarDeployment, setStellarDeployment] = useState<'sponsored' | 'self-funded'>('self-funded')
  const ethereum = useEthereumWallet()
  const effectiveStellarDeployment = allowSponsored ? stellarDeployment : 'self-funded'

  useEffect(() => {
    let active = true
    api
      // Desks are Stellar settlement contracts, so only assets with a Stellar side are selectable.
      .listCatalogAssets(mode)
      .then((all) => active && setCatalog(all.filter((a) => a.trusted_by_me && a.stellar_token)))
      .catch((e) => active && setError(errorMessage(e)))
    return () => {
      active = false
    }
  }, [mode])

  useEffect(() => {
    if (!allowSponsored) return
    api.getBaseDeploymentConfig().then(setDeploymentConfig).catch(() => setDeploymentConfig(null))
  }, [allowSponsored])

  // Selected catalog entries become desk assets, with asset_id assigned by selection order (1-based).
  const chosen = useMemo(() => selected
    .map((id) => catalog?.find((a) => a.id === id))
    .filter((a): a is CatalogAsset => !!a), [selected, catalog])
  const assetIdOf = useCallback((catalogId: string) => selected.indexOf(catalogId) + 1, [selected])
  const baseAssets = useMemo(() => eligibleBaseAssets(chosen), [chosen])
  const effectiveDeploymentConfig = allowSponsored ? deploymentConfig : null

  useEffect(() => {
    if (!deployBase || !ethereum.address || !ethereum.connectedToBase || !effectiveDeploymentConfig?.available || !effectiveDeploymentConfig.abi || !effectiveDeploymentConfig.bytecode || baseAssets.length === 0) {
      return
    }
    estimateBridgeDeployment({
      artifact: { abi: effectiveDeploymentConfig.abi, bytecode: effectiveDeploymentConfig.bytecode },
      account: ethereum.address,
      assetIds: baseAssets.map((asset) => assetIdOf(asset.id)),
      tokens: baseAssets.map((asset) => baseTokenAddress(asset) as Address),
    }).then((value) => setEstimatedFee(value.maxFee)).catch(() => setEstimatedFee(null))
  }, [deployBase, ethereum.address, ethereum.connectedToBase, effectiveDeploymentConfig, baseAssets, assetIdOf])

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
        catalog_id: a.id,
        asset_id: assetIdOf(a.id),
        symbol: a.symbol,
        token: a.stellar_token ?? 'native',
        decimals: a.stellar_decimals ?? 7,
        kind: assetKindOf(a),
      }))
      const deskPairs = pairs
        .filter((p) => p.base && p.quote && p.base !== p.quote)
        .map((p) => ({ base_asset: assetIdOf(p.base), quote_asset: assetIdOf(p.quote) }))
      if (assets.length === 0) throw new Error('Select at least one asset.')
      if (assets.length >= 2 && deskPairs.length === 0)
        throw new Error('Add at least one trading pair (base / quote).')
      if (deployBase && (!ethereum.address || !ethereum.connectedToBase)) {
        throw new Error('Connect MetaMask on Base Sepolia first.')
      }
      if (deployBase && baseAssets.length === 0) {
        throw new Error('Select at least one asset with a Base Sepolia ERC-20 mapping.')
      }
      if (deployBase && estimatedFee !== null && !hasEnoughEth(ethereum.balance, estimatedFee)) {
        throw new Error(`Insufficient Base Sepolia ETH. Estimated maximum fee: ${displayEth(estimatedFee)} ETH.`)
      }
      if (effectiveStellarDeployment === 'self-funded' && deployBase) {
        throw new Error('Base deployment setup currently requires the Mosaic Server sponsored deployment path.')
      }
      const deskBody = {
        name,
        assets,
        pairs: deskPairs,
        ...(deployBase && ethereum.address
          ? { base_deployment: { deployer_address: ethereum.address } }
          : {}),
      }
      const desk = effectiveStellarDeployment === 'self-funded'
        ? await api.createDeskSelfFunded({ name, assets, pairs: deskPairs })
        : await api.createDesk(deskBody)
      setCreatedDesk(desk)
      setName('')
      setSelected([])
      setPairs([])
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (createdDesk?.base_deployment) {
    return (
      <div className="card">
        <strong>Stellar desk created</strong>
        <div className="mono muted">{createdDesk.contract_id}</div>
        <BaseDeploymentPanel
          desk={createdDesk}
          autoStart
          onUpdated={(updated) => {
            setCreatedDesk(updated)
            onDone()
          }}
        />
        <p><button type="button" onClick={() => setCreatedDesk(null)}>Create another desk</button></p>
      </div>
    )
  }

  const effectiveEstimatedFee = deployBase && ethereum.connectedToBase ? estimatedFee : null

  return (
    <form onSubmit={submit} style={{ maxWidth: 560 }}>
      <label>Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} required style={{ width: '100%' }} />

      <label>Assets — tap to select / unselect from the assets you trust</label>
      {catalog === null && <p className="muted">Loading…</p>}
      {catalog?.length === 0 && (
        <p className="muted">
          No trusted assets. Add or trust one on the <Link to="/assets">Assets</Link> page.
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '4px 0 12px' }}>
        {catalog?.map((a) => {
          const on = selected.includes(a.id)
          const kind = assetKindOf(a)
          const badge = kind === 'BaseRepresented' ? 'Base→Stellar' : kind
          return (
            <button
              type="button"
              key={a.id}
              onClick={() => toggleAsset(a.id)}
              aria-pressed={on}
              title={
                kind === 'Stellar'
                  ? 'Distributed on Stellar — deposit by shielding'
                  : kind === 'Dual'
                    ? 'Distributed on Stellar and Base'
                    : 'Distributed on Base, represented on Stellar (trade-only)'
              }
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 999,
                border: on ? '1px solid #4f8cff' : '1px solid var(--border, #ccc)',
                background: on ? 'rgba(79,140,255,0.15)' : 'transparent',
                cursor: 'pointer',
              }}
            >
              <span>{a.symbol}</span>
              <span className="muted" style={{ fontSize: '0.8em' }}>{badge}</span>
              {on && <span className="muted" style={{ fontSize: '0.8em' }}>· #{assetIdOf(a.id)}</span>}
            </button>
          )
        })}
      </div>

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

      <label>Stellar deployment</label>
      <div className="segmented" style={{ marginBottom: 12 }}>
        <button
          type="button"
          aria-pressed={effectiveStellarDeployment === 'sponsored'}
          disabled={!allowSponsored}
          title={allowSponsored ? undefined : 'Trust Mosaic Server in the header to enable sponsorship'}
          onClick={() => setStellarDeployment('sponsored')}
        >
          Mosaic Server sponsored
        </button>
        <button
          type="button"
          aria-pressed={effectiveStellarDeployment === 'self-funded'}
          onClick={() => setStellarDeployment('self-funded')}
        >
          Trustless browser deploy
        </button>
      </div>

      {ethereum.address && (
        <div className="base-deployment">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={deployBase}
              disabled={!ethereum.connectedToBase || !effectiveDeploymentConfig?.available || baseAssets.length === 0}
              onChange={(event) => setDeployBase(event.target.checked)}
            />
            Deploy a MosaicBridge contract on Base Sepolia
          </label>
          <p className="warn">
            Optional and unchecked by default. Your MetaMask account pays Base Sepolia ETH for deployment gas.
          </p>
          {!effectiveDeploymentConfig?.available && <p className="muted">{effectiveDeploymentConfig?.reason ?? 'Base deployment configuration is unavailable.'}</p>}
          {baseAssets.length === 0 && <p className="muted">Select an asset with a Base Sepolia ERC-20 mapping to enable deployment.</p>}
          {baseAssets.length > 0 && <p className="muted">Will register: {baseAssets.map((asset) => `${asset.symbol} (#${assetIdOf(asset.id)})`).join(', ')}</p>}
          {deployBase && ethereum.balance !== null && <div>Base balance: {displayEth(ethereum.balance)} ETH</div>}
          {effectiveEstimatedFee !== null && <div>Estimated maximum fee: {displayEth(effectiveEstimatedFee)} ETH</div>}
        </div>
      )}

      {error && <p className="err">{error}</p>}
      <p>
        <button type="submit" disabled={busy || (effectiveEstimatedFee !== null && !hasEnoughEth(ethereum.balance, effectiveEstimatedFee))}>
          {busy ? 'Deploying… (~1 min)' : 'Create desk'}
        </button>
      </p>
    </form>
  )
}
