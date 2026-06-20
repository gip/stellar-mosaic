import { useState } from 'react'
import type { Desk } from '../api'
import { toRaw } from '../amount'
import { useRecovery } from '../RecoveryContext'
import { useActivity } from '../ActivityContext'

/**
 * Shield a supported asset into the desk's custody. Generates fresh note secrets in-browser,
 * derives the public owner_tag via the note_tag Noir helper, submits a user-signed shield, and
 * stores the private note locally (IndexedDB).
 */
export default function ShieldForm({
  desk,
  onDone,
}: {
  desk: Desk
  userPubkey: string
  onDone: () => void
}) {
  const [assetId, setAssetId] = useState(desk.assets[0]?.asset_id ?? 1)
  const [amount, setAmount] = useState('10')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recovery = useRecovery()
  const activity = useActivity()
  const recoveryReady = recovery.unlocked && !recovery.error

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const asset = desk.assets.find((a) => a.asset_id === assetId)!
      const rawAmount = toRaw(amount, asset.decimals)
      setStatus('Queueing shield…')
      const operation = await activity.enqueue({ kind: 'shield', desk_id: desk.id, asset_id: assetId, amount: rawAmount })
      setStatus(`Queued · ${operation.id.slice(0, 8)}`)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="row" style={{ alignItems: 'flex-end' }}>
      <div>
        <label>Asset</label>
        <select value={assetId} onChange={(e) => setAssetId(Number(e.target.value))}>
          {desk.assets.map((a) => (
            <option key={a.asset_id} value={a.asset_id}>
              {a.symbol}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label>Amount ({desk.assets.find((a) => a.asset_id === assetId)?.symbol ?? ''})</label>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      </div>
      <button type="submit" disabled={busy || !recoveryReady}>
        {busy ? 'Shielding…' : recoveryReady ? 'Shield' : 'Enable / repair recovery first'}
      </button>
      {status && <span className="muted">{status}</span>}
      {error && <span className="err">{error}</span>}
    </form>
  )
}
