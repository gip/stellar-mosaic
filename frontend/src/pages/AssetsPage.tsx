import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { api, type CatalogAsset } from '../api'
import { useWallet } from '../WalletContext'
import { useMosaicServer } from '../MosaicServerContext'
import { useStorageMode } from '../StorageModeContext'
import AssetList from '../components/AssetList'
import AddAssetForm from '../components/AddAssetForm'

export default function AssetsPage() {
  const { address } = useWallet()
  const mosaicServer = useMosaicServer()
  const storageMode = useStorageMode()
  const [assets, setAssets] = useState<CatalogAsset[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ready = !!address && (storageMode.mode === 'trustless' || mosaicServer.trusted)
  const visibleAssets = ready ? assets : null
  const visibleError = ready ? error : null

  const load = useCallback(async () => {
    if (!ready) return
    try {
      setAssets(await api.listCatalogAssets(storageMode.mode))
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [ready, storageMode.mode])

  // Reload when the wallet connects/disconnects so `trusted_by_me` reflects the current user.
  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setAssets(null)
      setError(null)
    })
    if (!ready) return () => { active = false }
    api
      .listCatalogAssets(storageMode.mode)
      .then((next) => {
        if (active) {
          setAssets(next)
          setError(null)
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e))
      })
    return () => {
      active = false
    }
  }, [ready, storageMode.mode])

  return (
    <>
      <h2>Assets</h2>
      <p className="muted">
        A mode-scoped catalog of cross-chain assets. Anyone can propose one; trust an asset to make it
        selectable when you create a desk. On-chain support is still set at contract deployment on
        both Base and Stellar.
      </p>
      {!address && <p className="muted">Connect Stellar to view and manage asset trust.</p>}
      {address && storageMode.mode === 'trusted' && !mosaicServer.trusted && <p className="muted">Switch to Trusted mode in the header to view and manage server-backed asset trust.</p>}
      {visibleError && <p className="err">{visibleError}</p>}
      {visibleAssets === null && !visibleError && ready && <p className="muted">Loading…</p>}
      {visibleAssets && <AssetList mode={storageMode.mode} assets={visibleAssets} onChange={load} />}

      <h2>Add asset</h2>
      {address && ready ? (
        <AddAssetForm mode={storageMode.mode} onDone={load} />
      ) : address ? (
        <p className="muted">Switch to Trusted mode before proposing a server-backed asset.</p>
      ) : (
        <p className="muted">Connect your wallet to propose a new asset.</p>
      )}
    </>
  )
}
