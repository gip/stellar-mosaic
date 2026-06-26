import { useEffect, useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { Link } from 'react-router-dom'
import { api, type Desk } from '../api'
import { useWallet } from '../WalletContext'
import { useMosaicServer } from '../MosaicServerContext'
import CreateDeskForm from '../components/CreateDeskForm'
import ImportDeskForm from '../components/ImportDeskForm'
import BaseDeploymentPanel from '../components/BaseDeploymentPanel'

export default function Home() {
  const { address } = useWallet()
  const mosaicServer = useMosaicServer()
  const [desks, setDesks] = useState<Desk[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      setDesks(await api.listDesks(mosaicServer.trusted))
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  useEffect(() => {
    let active = true
    api
      .listDesks(mosaicServer.trusted)
      .then((next) => {
        if (!active) return
        setDesks(next)
        setError(null)
      })
      .catch((e) => active && setError(errorMessage(e)))
    return () => {
      active = false
    }
  }, [mosaicServer.trusted])

  return (
    <>
      <h2>Desks</h2>
      {error && <p className="err">{error}</p>}
      {desks === null && !error && <p className="muted">Loading…</p>}
      {desks?.length === 0 && <p className="muted">No desks yet. Import one below.</p>}
      {desks?.map((d) => (
        <div className="card" key={d.id}>
          <h3>
            <Link to={`/desk/${d.id}`}>{d.name}</Link>
          </h3>
          <div className="mono muted">{d.contract_id}</div>
          <div style={{ marginTop: 8 }}>
            {d.pairs.length === 0 && <span className="muted">no pairs</span>}
            {d.pairs.map((p) => {
              const base = d.assets.find((a) => a.asset_id === p.base_asset)?.symbol ?? p.base_asset
              const quote =
                d.assets.find((a) => a.asset_id === p.quote_asset)?.symbol ?? p.quote_asset
              return (
                <span className="pill" key={p.pair_id}>
                  {base}/{quote}
                </span>
              )
            })}
          </div>
          {d.base_deployment && (
            <BaseDeploymentPanel
              desk={d}
              onUpdated={(updated) => setDesks((current) => current?.map((desk) => desk.id === updated.id ? updated : desk) ?? null)}
            />
          )}
        </div>
      ))}

      {address ? (
        <>
          <h2>Create desk</h2>
          {!mosaicServer.trusted && (
            <p className="muted">
              Trustless mode deploys from this browser with Freighter and stores desk metadata locally.
              Trust Mosaic Server only if you want sponsored deployment or shared import/catalog workflows.
            </p>
          )}
          <CreateDeskForm onDone={load} allowSponsored={mosaicServer.trusted} />

          {mosaicServer.trusted && (
            <details style={{ marginTop: 24 }}>
              <summary className="muted" style={{ cursor: 'pointer' }}>
                Import an existing contract instead
              </summary>
              <div style={{ marginTop: 12 }}>
                <ImportDeskForm onDone={load} />
              </div>
            </details>
          )}
        </>
      ) : (
        <p className="muted">Connect your wallet to create or import a desk.</p>
      )}
    </>
  )
}
