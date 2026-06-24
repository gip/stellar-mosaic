import { useCallback, useEffect, useState } from 'react'
import { api, type CatalogAsset } from '../api'
import { useWallet } from '../WalletContext'
import AssetList from '../components/AssetList'
import AddAssetForm from '../components/AddAssetForm'

export default function AssetsPage() {
  const { address } = useWallet()
  const [assets, setAssets] = useState<CatalogAsset[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setAssets(await api.listCatalogAssets())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // Reload when the wallet connects/disconnects so `trusted_by_me` reflects the current user. Set
  // state inside the async callback (not synchronously in the effect body) and guard against a stale
  // resolve after unmount / a newer wallet change.
  useEffect(() => {
    let active = true
    api
      .listCatalogAssets()
      .then((a) => {
        if (!active) return
        setAssets(a)
        setError(null)
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      active = false
    }
  }, [address])

  return (
    <>
      <h2>Assets</h2>
      <p className="muted">
        A shared catalog of cross-chain assets. Anyone can propose one; trust an asset to make it
        selectable when you create a desk. On-chain support is still set at contract deployment on
        both Base and Stellar.
      </p>
      {error && <p className="err">{error}</p>}
      {assets === null && !error && <p className="muted">Loading…</p>}
      {assets && <AssetList assets={assets} onChange={load} />}

      <h2>Add asset</h2>
      {address ? (
        <AddAssetForm onDone={load} />
      ) : (
        <p className="muted">Connect your wallet to propose a new asset.</p>
      )}
    </>
  )
}
