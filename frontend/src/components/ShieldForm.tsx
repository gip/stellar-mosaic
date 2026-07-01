import { useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import type { Desk } from '../api'
import { toRaw } from '../amount'
import { useRecovery } from '../RecoveryContext'
import { useActivity } from '../ActivityContext'
import { useMosaicServer } from '../MosaicServerContext'
import { shieldTrustless } from '../trustless'
import Field from './ui/Field'
import ProgressSteps from './ui/ProgressSteps'

function parseAmount(amount: string, decimals: number): bigint | null {
  if (amount.trim() === '') return null
  try {
    return BigInt(toRaw(amount, decimals))
  } catch {
    return null
  }
}

/**
 * Shield a supported asset into the desk's custody. Generates fresh note secrets in-browser,
 * derives the public owner_tag via the note_tag Noir helper, submits a user-signed shield, and
 * stores the private note locally (IndexedDB).
 */
export default function ShieldForm({
  desk,
  userPubkey,
  disabledReason,
  trustless = false,
  onDone,
}: {
  desk: Desk
  userPubkey: string
  disabledReason?: string | null
  trustless?: boolean
  onDone: () => void
}) {
  const [assetId, setAssetId] = useState(desk.assets[0]?.asset_id ?? 1)
  const [amount, setAmount] = useState('10')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recovery = useRecovery()
  const activity = useActivity()
  const mosaicServer = useMosaicServer()
  const recoveryReady = recovery.unlocked && !recovery.error

  const asset = desk.assets.find((a) => a.asset_id === assetId)
  const decimals = asset?.decimals ?? 7
  const amountRaw = parseAmount(amount, decimals)
  const amountError =
    amount.trim() === ''
      ? null
      : amountRaw == null
        ? `Enter a valid amount with at most ${decimals} decimal places.`
        : amountRaw <= 0n
          ? 'Amount must be greater than zero.'
          : null
  const valid = amountRaw != null && amountRaw > 0n

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const rawAmount = amountRaw!.toString()
      if (mosaicServer.trusted && !trustless) {
        setStatus('Queueing shield…')
        const operation = await activity.enqueue({ kind: 'shield', desk_id: desk.id, asset_id: assetId, amount: rawAmount })
        setStatus(`Queued · ${operation.id.slice(0, 8)}`)
      } else {
        setStatus('Proving & submitting in browser…')
        const note = await shieldTrustless(desk, { address: userPubkey, assetId, amount: rawAmount })
        setStatus(note.indexed ? 'Shielded ✓' : 'Shielded — indexing…')
      }
      onDone()
    } catch (e) {
      setError(errorMessage(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <Field id="shield-asset" label="Asset">
        <select value={assetId} onChange={(e) => setAssetId(Number(e.target.value))}>
          {desk.assets.map((a) => (
            <option key={a.asset_id} value={a.asset_id}>
              {a.symbol}
            </option>
          ))}
        </select>
      </Field>
      <Field id="shield-amount" label={`Amount (${asset?.symbol ?? ''})`} error={amountError}>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      </Field>
      <button className="btn-primary btn-block" type="submit" disabled={busy || !valid || !recoveryReady || !!disabledReason}>
        {busy
          ? 'Shielding…'
          : disabledReason
            ? 'Waiting for contract verification'
            : recoveryReady
              ? 'Shield from Stellar'
              : 'Enable / repair recovery first'}
      </button>
      <ProgressSteps running={busy} step={status} />
      {!busy && status && !error && <div className="status-dot ok">{status}</div>}
      {error && <div className="banner err" role="alert">{error}</div>}
    </form>
  )
}
