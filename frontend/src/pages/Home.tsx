import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Desk } from '../api'
import CreateDeskForm from '../components/CreateDeskForm'
import ImportDeskForm from '../components/ImportDeskForm'

export default function Home() {
  const [desks, setDesks] = useState<Desk[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      setDesks(await api.listDesks())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    load()
  }, [])

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
        </div>
      ))}

      <h2>Create desk</h2>
      <CreateDeskForm onDone={load} />

      <details style={{ marginTop: 24 }}>
        <summary className="muted" style={{ cursor: 'pointer' }}>
          Import an existing contract instead
        </summary>
        <div style={{ marginTop: 12 }}>
          <ImportDeskForm onDone={load} />
        </div>
      </details>
    </>
  )
}
