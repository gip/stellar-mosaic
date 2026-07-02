import { useCallback, useEffect, useMemo, useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { Link } from 'react-router-dom'
import { api, type BaseDeploymentConfig, type CatalogAsset } from '../api'
import { useEthereumWallet } from '../EthereumWalletContext'
import { displayEth, estimateBridgeDeployment } from '../base'
import type { Address } from 'viem'
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
  const [deploymentConfig, setDeploymentConfig] = useState<BaseDeploymentConfig | null>(null)
  const [estimatedFee, setEstimatedFee] = useState<bigint | null>(null)
  // Trustless desks may optionally also deploy a Base Sepolia bridge for their Base-backed assets.
  const [deployBaseBridge, setDeployBaseBridge] = useState(true)
  // Off by default: mint Base deposits as soon as they are proven. On makes the worker wait for
  // Base L1 finality before minting (safer against a Base reorg, but adds several minutes).
  const [waitForFinality, setWaitForFinality] = useState(false)
  const ethereum = useEthereumWallet()
  const canSelfFund = mode === 'trustless'
  const effectiveStellarDeployment: 'sponsored' | 'self-funded' = canSelfFund ? 'self-funded' : 'sponsored'

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
  // Sponsored desks always bridge their Base-backed assets; trustless desks let the user opt out.
  const wantsBaseBridge = baseAssets.length > 0 && (canSelfFund ? deployBaseBridge : true)

  useEffect(() => {
    // Only the self-funded (trustless) path deploys the bridge from the browser wallet, so it is the
    // only path that estimates the wallet's gas. Trusted desks are deployed by the MCP server.
    if (!canSelfFund || baseAssets.length === 0 || !ethereum.address || !ethereum.connectedToBase || !effectiveDeploymentConfig?.available || !effectiveDeploymentConfig.abi || !effectiveDeploymentConfig.bytecode) {
      return
    }
    estimateBridgeDeployment({
      artifact: { abi: effectiveDeploymentConfig.abi, bytecode: effectiveDeploymentConfig.bytecode },
      account: ethereum.address,
      assetIds: baseAssets.map((asset) => assetIdOf(asset.id)),
      tokens: baseAssets.map((asset) => baseTokenAddress(asset) as Address),
    }).then((value) => setEstimatedFee(value.maxFee)).catch(() => setEstimatedFee(null))
  }, [canSelfFund, ethereum.address, ethereum.connectedToBase, effectiveDeploymentConfig, baseAssets, assetIdOf])

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

  function resetForm() {
    setName('')
    setSelected([])
    setPairs([])
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
      const deployBase = wantsBaseBridge
      const baseMappings = baseAssets.map((asset) => ({
        asset_id: assetIdOf(asset.id),
        symbol: asset.symbol,
        token: baseTokenAddress(asset),
      }))

      if (effectiveStellarDeployment === 'self-funded') {
        // Trustless: the browser wallet pays, so it deploys the Stellar contract *and* the Base
        // bridge (via the SDK) and records its own activity.
        if (deployBase && (!ethereum.address || !ethereum.connectedToBase)) {
          throw new Error('Connect MetaMask on Base Sepolia first.')
        }
        if (deployBase && estimatedFee !== null && !hasEnoughEth(ethereum.balance, estimatedFee)) {
          throw new Error(`Insufficient Base Sepolia ETH. Estimated maximum fee: ${displayEth(estimatedFee)} ETH.`)
        }
        await api.createDeskSelfFunded({ name, assets, pairs: deskPairs, base_assets: deployBase ? baseMappings : undefined, require_finality: deployBase ? waitForFinality : undefined })
        resetForm()
        onDone()
        return
      }

      // Trusted/sponsored: the MCP server deploys everything — the Stellar contract and the Base
      // bridge (paid by the operator sponsor key) — and records the deploy activity itself, so there
      // is nothing to sign in the browser. The returned desk already reflects the bridge status.
      await api.createDesk({ name, assets, pairs: deskPairs, base_assets: deployBase ? baseMappings : undefined, require_finality: deployBase ? waitForFinality : undefined })
      resetForm()
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  // Only the self-funded (trustless) path pays for the bridge from the browser wallet.
  const effectiveEstimatedFee = canSelfFund && wantsBaseBridge && ethereum.connectedToBase ? estimatedFee : null

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

      {baseAssets.length > 0 && (
        <div className="base-deployment">
          <strong>Base Sepolia bridge</strong>
          {canSelfFund ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }}>
              <input
                type="checkbox"
                checked={deployBaseBridge}
                onChange={(e) => setDeployBaseBridge(e.target.checked)}
              />
              Also deploy a Base Sepolia bridge for {baseAssets.map((asset) => asset.symbol).join(', ')}
            </label>
          ) : (
            <p className="muted">
              The server deploys and funds a MosaicBridge contract automatically — no wallet needed.
            </p>
          )}
          {wantsBaseBridge && (
            <>
              {canSelfFund && (
                <>
                  <p className="warn">Your MetaMask account pays Base Sepolia ETH for deployment gas.</p>
                  {!ethereum.address && <p className="muted">Connect MetaMask on Base Sepolia to continue.</p>}
                  {ethereum.balance !== null && <div>Base balance: {displayEth(ethereum.balance)} ETH</div>}
                  {effectiveEstimatedFee !== null && <div>Estimated maximum fee: {displayEth(effectiveEstimatedFee)} ETH</div>}
                </>
              )}
              {!canSelfFund && effectiveDeploymentConfig && !effectiveDeploymentConfig.server_deploys && (
                <p className="warn">
                  This server is not configured to deploy Base bridges — desk creation will fail. Ask the operator to set MOSAIC_BASE_DEPLOYER_KEY.
                </p>
              )}
              <p className="muted">Will register: {baseAssets.map((asset) => `${asset.symbol} (#${assetIdOf(asset.id)})`).join(', ')}</p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }}>
                <input
                  type="checkbox"
                  checked={waitForFinality}
                  onChange={(e) => setWaitForFinality(e.target.checked)}
                />
                Wait for Base L1 finality before minting (safer, adds several minutes)
              </label>
            </>
          )}
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
