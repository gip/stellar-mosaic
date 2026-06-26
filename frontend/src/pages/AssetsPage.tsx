import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { api, type CatalogAsset } from '../api'
import { useWallet } from '../WalletContext'
import { useMosaicServer } from '../MosaicServerContext'
import AssetList from '../components/AssetList'
import AddAssetForm from '../components/AddAssetForm'

export default function AssetsPage() {
  const { address } = useWallet()
  const mosaicServer = useMosaicServer()
  const [assets, setAssets] = useState<CatalogAsset[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const serverReady = !!address && mosaicServer.trusted
  const visibleAssets = serverReady ? assets : null
  const visibleError = serverReady ? error : null

  const load = useCallback(async () => {
    if (!serverReady) return
    try {
      setAssets(await api.listCatalogAssets())
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [serverReady])

  // Reload when the wallet connects/disconnects so `trusted_by_me` reflects the current user.
  useEffect(() => {
    let active = true
    if (!serverReady) return () => { active = false }
    api
      .listCatalogAssets()
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
  }, [serverReady])

  return (
    <>
      <h2>Assets</h2>
      <p className="muted">
        A shared catalog of cross-chain assets. Anyone can propose one; trust an asset to make it
        selectable when you create a desk. On-chain support is still set at contract deployment on
        both Base and Stellar.
      </p>
      {!address && <p className="muted">Connect Stellar and trust Mosaic Server to view and manage asset trust.</p>}
      {address && !mosaicServer.trusted && <p className="muted">Trust Mosaic Server in the header to view and manage asset trust.</p>}
      {visibleError && <p className="err">{visibleError}</p>}
      {visibleAssets === null && !visibleError && serverReady && <p className="muted">Loading…</p>}
      {visibleAssets && <AssetList assets={visibleAssets} onChange={load} />}

      <h2>Add asset</h2>
      {address && mosaicServer.trusted ? (
        <AddAssetForm onDone={load} />
      ) : address ? (
        <p className="muted">Trust Mosaic Server before proposing a new asset.</p>
      ) : (
        <p className="muted">Connect your wallet to propose a new asset.</p>
      )}
    </>
  )
}
