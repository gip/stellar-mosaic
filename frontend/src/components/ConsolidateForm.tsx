import { useMemo, useState } from 'react'
import type { Desk } from '../api'
import { api } from '../api'
import { randomField } from '../crypto'
import { joinTerms } from '../noir'
import { proveJoin, b64 } from '../prove'
import { addNote, updateNote, type Note } from '../notes'
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
      // Fresh secrets for each output note (per-note keys, like shield).
      const sk_out1 = randomField()
      const rho_out1 = randomField()
      const sk_out2 = randomField()
      const rho_out2 = randomField()
      setStatus('Deriving join terms…')
      const terms = await joinTerms({
        sk_1: a.sk,
        rho_1: a.rho,
        sk_2: b.sk,
        rho_2: b.rho,
        sk_out1,
        rho_out1,
        sk_out2,
        rho_out2,
      })

      setStatus('Fetching membership paths…')
      const [pa, pb] = await Promise.all([
        api.getNoteProof(desk.id, a.owner_tag),
        api.getNoteProof(desk.id, b.owner_tag),
      ])
      // Both paths must be against the same root (the circuit folds both to one). If the tree
      // advanced between the two fetches, the roots differ — ask the user to retry.
      if (pa.root.toLowerCase() !== pb.root.toLowerCase()) {
        throw new Error('Tree advanced between path fetches; please retry.')
      }

      setStatus('Proving (UltraHonk, in-browser)…')
      const bundle = await proveJoin({
        sk_1: a.sk,
        rho_1: a.rho,
        amount_1: a.amount,
        path_1: pa.siblings,
        index_bits_1: pa.index_bits,
        sk_2: b.sk,
        rho_2: b.rho,
        amount_2: b.amount,
        path_2: pb.siblings,
        index_bits_2: pb.index_bits,
        root: pa.root,
        nullifier_1: terms.nullifier_1,
        nullifier_2: terms.nullifier_2,
        asset: a.asset_id,
        out_tag_1: terms.out_tag_1,
        out_amount_1: targetRaw.toString(),
        out_tag_2: terms.out_tag_2,
        out_amount_2: changeRaw.toString(),
      })

      setStatus('Submitting (sponsored)…')
      await api.relayJoin(desk.id, b64(bundle.proof), b64(bundle.publicInputs))

      // Both inputs are now spent; record the two fresh outputs as pending (reconcile confirms them
      // + stamps leaf_index once the on-chain `noteins` events are indexed).
      await updateNote(a.id, { status: 'spent' })
      await updateNote(b.id, { status: 'spent' })
      await addNote({
        id: crypto.randomUUID(),
        deskId: desk.id,
        role: 'asset',
        asset_id: a.asset_id,
        symbol: a.symbol,
        amount: targetRaw.toString(),
        sk: sk_out1,
        rho: rho_out1,
        owner_tag: terms.out_tag_1,
        status: 'pending',
        createdAt: Date.now(),
      })
      if (changeRaw > 0n) {
        await addNote({
          id: crypto.randomUUID(),
          deskId: desk.id,
          role: 'asset',
          asset_id: a.asset_id,
          symbol: a.symbol,
          amount: changeRaw.toString(),
          sk: sk_out2,
          rho: rho_out2,
          owner_tag: terms.out_tag_2,
          status: 'pending',
          createdAt: Date.now(),
        })
      }
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
