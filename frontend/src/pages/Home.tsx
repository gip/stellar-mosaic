import { useEffect, useMemo, useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { Link } from 'react-router-dom'
import { api, type Desk } from '../api'
import { useWallet } from '../WalletContext'
import { useMosaicServer } from '../MosaicServerContext'
import CreateDeskForm from '../components/CreateDeskForm'
import ImportDeskForm from '../components/ImportDeskForm'
import BaseDeploymentPanel from '../components/BaseDeploymentPanel'

const HIDDEN_DESKS_KEY = 'mosaic.hiddenDesks'

function readHiddenDesks(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_DESKS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeHiddenDesks(ids: string[]) {
  try {
    localStorage.setItem(HIDDEN_DESKS_KEY, JSON.stringify(ids))
  } catch {
    // Keep the in-memory state even if browser storage is unavailable.
  }
}

export default function Home() {
  const { address } = useWallet()
  const mosaicServer = useMosaicServer()
  const [desks, setDesks] = useState<Desk[] | null>(null)
  const [hiddenDeskIds, setHiddenDeskIds] = useState<string[]>(readHiddenDesks)
  const [error, setError] = useState<string | null>(null)
  const hiddenDeskSet = useMemo(() => new Set(hiddenDeskIds), [hiddenDeskIds])
  const visibleDesks = desks?.filter((desk) => !hiddenDeskSet.has(desk.id)) ?? null
  const hiddenDesks = desks?.filter((desk) => hiddenDeskSet.has(desk.id)) ?? []

  function hideDesk(id: string) {
    setHiddenDeskIds((current) => {
      if (current.includes(id)) return current
      const next = [...current, id]
      writeHiddenDesks(next)
      return next
    })
  }

  function showDesk(id: string) {
    setHiddenDeskIds((current) => {
      const next = current.filter((deskId) => deskId !== id)
      writeHiddenDesks(next)
      return next
    })
  }

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
      {visibleDesks?.length === 0 && hiddenDesks.length === 0 && <p className="muted">No desks yet. Import one below.</p>}
      {visibleDesks?.length === 0 && hiddenDesks.length > 0 && <p className="muted">No visible desks.</p>}
      {visibleDesks?.map((d) => (
        <div className="card" key={d.id}>
          <div className="card-title-row">
            <h3>
              <Link to={`/desk/${d.id}`}>{d.name}</Link>
            </h3>
            <button type="button" onClick={() => hideDesk(d.id)} title="Hide from desk list">
              Hide
            </button>
          </div>
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

      {hiddenDesks.length > 0 && (
        <details className="hidden-desks">
          <summary className="muted">Hidden desks ({hiddenDesks.length})</summary>
          {hiddenDesks.map((d) => (
            <div className="hidden-desk-row" key={d.id}>
              <div>
                <Link to={`/desk/${d.id}`}>{d.name}</Link>
                <div className="mono muted">{d.contract_id}</div>
              </div>
              <button type="button" onClick={() => showDesk(d.id)}>
                Show
              </button>
            </div>
          ))}
        </details>
      )}

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
