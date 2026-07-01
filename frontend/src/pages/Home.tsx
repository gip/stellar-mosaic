import { useEffect, useMemo, useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { Link } from 'react-router-dom'
import { api, type Desk } from '../api'
import { useWallet } from '../WalletContext'
import { useMosaicServer } from '../MosaicServerContext'
import { useStorageMode, type StorageMode } from '../StorageModeContext'
import CreateDeskForm from '../components/CreateDeskForm'
import ImportDeskForm from '../components/ImportDeskForm'
import BaseDeploymentPanel from '../components/BaseDeploymentPanel'
import DeskShareButton from '../components/DeskShareButton'

const HIDDEN_DESKS_KEY = 'mosaic.hiddenDesks'
type DeskAction = 'create' | 'import'

function hiddenDesksKey(mode: StorageMode) {
  return `${HIDDEN_DESKS_KEY}.${mode}`
}

function readHiddenDesks(mode: StorageMode): string[] {
  try {
    const raw = localStorage.getItem(hiddenDesksKey(mode))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeHiddenDesks(mode: StorageMode, ids: string[]) {
  try {
    localStorage.setItem(hiddenDesksKey(mode), JSON.stringify(ids))
  } catch {
    // Keep the in-memory state even if browser storage is unavailable.
  }
}

export default function Home() {
  const { address, ready } = useWallet()
  const mosaicServer = useMosaicServer()
  const storageMode = useStorageMode()
  const [desks, setDesks] = useState<Desk[] | null>(null)
  const [hiddenDeskIds, setHiddenDeskIds] = useState<string[]>(() => readHiddenDesks(storageMode.mode))
  const [error, setError] = useState<string | null>(null)
  const [actionOpen, setActionOpen] = useState(false)
  const [deskAction, setDeskAction] = useState<DeskAction>('create')
  const hiddenDeskSet = useMemo(() => new Set(hiddenDeskIds), [hiddenDeskIds])
  const visibleDesks = desks?.filter((desk) => !hiddenDeskSet.has(desk.id)) ?? null
  const hiddenDesks = desks?.filter((desk) => hiddenDeskSet.has(desk.id)) ?? []
  const canImport = storageMode.mode === 'trustless'
  const activeDeskAction = canImport ? deskAction : 'create'

  function hideDesk(id: string) {
    setHiddenDeskIds((current) => {
      if (current.includes(id)) return current
      const next = [...current, id]
      writeHiddenDesks(storageMode.mode, next)
      return next
    })
  }

  function showDesk(id: string) {
    setHiddenDeskIds((current) => {
      const next = current.filter((deskId) => deskId !== id)
      writeHiddenDesks(storageMode.mode, next)
      return next
    })
  }

  async function load() {
    try {
      setDesks(await api.listDesks(storageMode.mode))
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  function openActions() {
    if (!actionOpen) setDeskAction(address ? 'create' : canImport ? 'import' : 'create')
    setActionOpen((open) => !open)
  }

  function doneWithAction() {
    setActionOpen(false)
    void load()
  }

  useEffect(() => {
    if (!address) return
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setDesks(null)
      setError(null)
      setHiddenDeskIds(readHiddenDesks(storageMode.mode))
    })
    api
      .listDesks(storageMode.mode)
      .then((next) => {
        if (!active) return
        setDesks(next)
        setError(null)
      })
      .catch((e) => active && setError(errorMessage(e)))
    return () => {
      active = false
    }
  }, [address, storageMode.mode])

  // Wait for the wallet check to resolve before deciding there's no session — `address` starts
  // out null on every mount, so trusting it before `ready` would flash the logged-out intro for
  // an already-connected wallet (matches the ready-gating StorageModeContext already relies on).
  if (!ready) return <div className="reading"><p className="muted">Loading…</p></div>

  if (!address) {
    return (
      <div className="reading intro">
        <p>
          Stellar Mosaic is a privacy-preserving DEX on Stellar: trades settle atomically on-chain
          while the owner behind each note and the create-to-spend link stay hidden.
        </p>
      </div>
    )
  }

  return (
    <div className="reading">
      <div className="desk-toolbar">
        <h2>Desks</h2>
        <button
          type="button"
          className="desk-add-button"
          aria-label="Add desk"
          aria-expanded={actionOpen}
          onClick={openActions}
          title="Add desk"
        >
          +
        </button>
      </div>
      {error && <div className="banner err" role="alert">{error}</div>}
      {desks === null && !error && <p className="muted">Loading…</p>}
      {visibleDesks?.length === 0 && hiddenDesks.length === 0 && <p className="muted">No desks yet.</p>}
      {visibleDesks?.length === 0 && hiddenDesks.length > 0 && <p className="muted">No visible desks.</p>}
      {actionOpen && (
        <div className="pane desk-action-panel">
          <div className="pane-header">
            <div className="segmented">
              <button type="button" aria-pressed={activeDeskAction === 'create'} onClick={() => setDeskAction('create')}>
                Create
              </button>
              {canImport && (
                <button type="button" aria-pressed={activeDeskAction === 'import'} onClick={() => setDeskAction('import')}>
                  Import
                </button>
              )}
            </div>
            <button className="btn-ghost btn-sm" type="button" onClick={() => setActionOpen(false)}>
              Close
            </button>
          </div>
          {activeDeskAction === 'create' ? (
            address ? (
              <>
                {!mosaicServer.trusted && (
                  <p className="muted">
                    Trustless mode deploys from this browser with Freighter and stores desk metadata locally.
                    Switch to Trusted mode only if you want sponsored deployment or server-backed workflows.
                  </p>
                )}
                <CreateDeskForm mode={storageMode.mode} onDone={doneWithAction} allowSponsored={mosaicServer.trusted} />
              </>
            ) : (
              <p className="muted">Connect your wallet to create a desk.</p>
            )
          ) : (
            <ImportDeskForm onDone={doneWithAction} />
          )}
        </div>
      )}
      {visibleDesks && visibleDesks.length > 0 && (
        <div className="card-grid">
          {visibleDesks.map((d) => (
            <div className="card" key={d.id}>
              <div className="card-title-row">
                <h3>
                  <Link to={`/desk/${d.id}`}>{d.name}</Link>
                </h3>
                <button className="btn-ghost btn-sm" type="button" onClick={() => hideDesk(d.id)} title="Hide from desk list">
                  Hide
                </button>
              </div>
              <div className="mono muted">{d.contract_id}</div>
              {storageMode.mode === 'trustless' && <DeskShareButton desk={d} />}
              <div className="balances" style={{ marginTop: 'var(--sp-2)' }}>
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
        </div>
      )}

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

    </div>
  )
}
