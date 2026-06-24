import { useState } from 'react'
import { StrKey } from '@stellar/stellar-sdk'
import type { Desk } from '../api'
import { toRaw, formatAmount } from '../amount'
import { maxIn, planAssembly } from '../orderPlan'
import type { Note } from '../notes'
import { useRecovery } from '../RecoveryContext'
import { useActivity } from '../ActivityContext'

function parseAmount(amount: string, decimals: number): bigint | null {
  if (amount.trim() === '') return null
  try {
    return BigInt(toRaw(amount, decimals))
  } catch {
    return null
  }
}

/** Withdraw an exact asset amount, assembling a full-consumption note first when necessary. */
export default function UnshieldForm({
  desk,
  notes,
  userPubkey,
  disabledReason,
  onDone,
}: {
  desk: Desk
  notes: Note[]
  userPubkey: string
  disabledReason?: string | null
  onDone: () => void
}) {
  const [assetId, setAssetId] = useState(desk.assets[0]?.asset_id ?? 1)
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState(userPubkey)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recovery = useRecovery()
  const activity = useActivity()
  const recoveryReady = recovery.unlocked && !recovery.error

  const asset = desk.assets.find((a) => a.asset_id === assetId)
  const decimals = asset?.decimals ?? 7
  const maxRaw = maxIn(notes, assetId)
  const amountRaw = parseAmount(amount, decimals)
  const plan = amountRaw != null && amountRaw > 0n ? planAssembly(notes, assetId, amountRaw) : null
  const recipientValid = StrKey.isValidEd25519PublicKey(recipient.trim())
  const needsRecovery = plan?.kind === 'assemble'
  const valid =
    amountRaw != null &&
    amountRaw > 0n &&
    plan != null &&
    plan.kind !== 'impossible' &&
    recipientValid

  const preview = (() => {
    if (amount.trim() === '') return null
    if (amountRaw == null) return `Enter a valid amount with at most ${decimals} decimal places.`
    if (amountRaw <= 0n) return 'Amount must be greater than zero.'
    if (amountRaw > maxRaw) {
      return `Exceeds max ${formatAmount(maxRaw, decimals)} ${asset?.symbol ?? `#${assetId}`}.`
    }
    if (plan?.kind === 'impossible') return plan.reason
    if (plan?.kind === 'assemble') {
      const singleSplit = plan.steps.length === 1 && plan.steps[0].op === 'split'
      if (singleSplit) return 'Will split a note to the exact amount, then unshield it.'
      return `Will prepare the exact note in ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}, then unshield it.`
    }
    if (plan?.kind === 'direct') return 'A matching note is ready — unshields in one step.'
    return null
  })()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (amountRaw == null || plan == null || !recipientValid) return
    if (plan.kind === 'impossible') {
      setError(plan.reason)
      return
    }

    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      setStatus('Queueing unshield…')
      const operation = await activity.enqueue({
        kind: 'unshield', desk_id: desk.id, asset_id: assetId,
        amount: amountRaw.toString(), recipient: recipient.trim(),
      })
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
        <label>
          Amount ({asset?.symbol ?? ''}) · max {formatAmount(maxRaw, decimals)}
        </label>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder={formatAmount(maxRaw, decimals)}
        />
        <button
          type="button"
          style={{ padding: '2px 8px', marginLeft: 6 }}
          onClick={() => setAmount(formatAmount(maxRaw, decimals))}
          disabled={maxRaw <= 0n || busy}
        >
          max
        </button>
      </div>
      <div>
        <label>Recipient</label>
        <input
          className="mono"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="G…"
          size={58}
        />
      </div>
      <button
        type="submit"
        disabled={busy || !valid || !!disabledReason || (!!needsRecovery && !recoveryReady)}
      >
        {busy
          ? 'Working…'
          : disabledReason
            ? 'Waiting for contract verification'
          : needsRecovery && !recoveryReady
            ? 'Enable / repair recovery to prepare note'
            : 'Unshield'}
      </button>
      {!recipientValid && recipient.trim() !== '' && !error && (
        <span className="err">Enter a valid Stellar G… account.</span>
      )}
      {preview && !error && <span className="muted">{preview}</span>}
      {status && <span className="muted">{status}</span>}
      {error && <span className="err">{error}</span>}
    </form>
  )
}
