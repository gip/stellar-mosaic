import { useMemo, useState } from 'react'
import type { Desk } from '../api'
import { executeJoin } from '../orchestrate'
import { type Note } from '../notes'
import { toRaw, formatAmount } from '../amount'

/**
 * Consolidate two shielded asset notes of the same asset into two fresh notes: a `target` of a
 * chosen amount and the `change`. Stays entirely inside the shielded pool (no unshield) — this is
 * how a wallet assembles the exact denomination a full-consumption order needs (e.g. merge 1.5 + 2
 * USDC into 3 + 0.5, then place a 3-USDC order). Proves the join circuit in-browser and relays a
 * fully-sponsored `join`. On success both inputs are marked spent and the two outputs are saved as
 * pending notes (reconciliation stamps their leaf index + confirms them once they appear on-chain).
 */
export default function ConsolidateForm({
  desk,
  notes,
  onDone,
}: {
  desk: Desk
  notes: Note[]
  onDone: () => void
}) {
  const [aId, setAId] = useState('')
  const [bId, setBId] = useState('')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const dec = (id: number) => desk.assets.find((a) => a.asset_id === id)?.decimals ?? 7

  // Confirmed, spendable notes can be consolidated.
  const spendable = useMemo(() => notes.filter((n) => n.status === 'confirmed'), [notes])
  const a = spendable.find((n) => n.id === aId)
  // The second note must be a *different* note of the *same* asset as the first.
  const bOptions = useMemo(
    () => (a ? spendable.filter((n) => n.id !== a.id && n.asset_id === a.asset_id) : []),
    [spendable, a],
  )
  const b = bOptions.find((n) => n.id === bId)

  const sum = a && b ? BigInt(a.amount) + BigInt(b.amount) : null
  const targetRaw = (() => {
    if (!a || target.trim() === '') return null
    try {
      return BigInt(toRaw(target, dec(a.asset_id)))
    } catch {
      return null
    }
  })()
  const changeRaw = sum != null && targetRaw != null ? sum - targetRaw : null
  const valid =
    a != null && b != null && targetRaw != null && targetRaw > 0n && changeRaw != null && changeRaw >= 0n

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!a || !b || sum == null || targetRaw == null || changeRaw == null) return
    if (targetRaw <= 0n || changeRaw < 0n) {
      setError(`Target must be between 0 and the combined ${formatAmount(sum, dec(a.asset_id))}.`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      // The shared join primitive proves + relays and records the two fresh outputs as pending
      // (reconcile confirms them + stamps leaf_index once the on-chain `noteins` events are indexed).
      await executeJoin(desk, a, b, targetRaw, changeRaw, setStatus)
      setStatus('Consolidated.')
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  if (spendable.length < 2) {
    return <p className="muted">Need at least two confirmed notes of the same asset to consolidate.</p>
  }

  return (
    <form onSubmit={submit} className="row" style={{ alignItems: 'flex-end' }}>
      <div>
        <label>Note A</label>
        <select
          value={a?.id ?? ''}
          onChange={(e) => {
            setAId(e.target.value)
            setBId('') // asset may change; reset B
          }}
        >
          <option value="">select…</option>
          {spendable.map((n) => (
            <option key={n.id} value={n.id}>
              {formatAmount(n.amount, dec(n.asset_id))} {n.symbol} · {n.owner_tag.slice(0, 10)}…
            </option>
          ))}
        </select>
      </div>
      <div>
        <label>Note B ({a ? a.symbol : '—'})</label>
        <select value={b?.id ?? ''} onChange={(e) => setBId(e.target.value)} disabled={!a}>
          <option value="">{a ? 'select…' : 'pick A first'}</option>
          {bOptions.map((n) => (
            <option key={n.id} value={n.id}>
              {formatAmount(n.amount, dec(n.asset_id))} {n.symbol} · {n.owner_tag.slice(0, 10)}…
            </option>
          ))}
        </select>
      </div>
      <div>
        <label>Target {a && `(${a.symbol})`}</label>
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          inputMode="decimal"
          placeholder={sum != null && a ? formatAmount(sum, dec(a.asset_id)) : ''}
        />
      </div>
      <div className="muted">
        {sum != null && a && `combined ${formatAmount(sum, dec(a.asset_id))}`}
        {changeRaw != null && changeRaw >= 0n && a && ` · change ${formatAmount(changeRaw, dec(a.asset_id))}`}
      </div>
      <button type="submit" disabled={busy || !valid}>
        {busy ? 'Working…' : 'Consolidate'}
      </button>
      {status && <span className="muted">{status}</span>}
      {error && <span className="err">{error}</span>}
    </form>
  )
}
