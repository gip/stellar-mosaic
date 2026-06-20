import { useState } from 'react'
import { api, type Desk } from '../api'
import { randomField, fieldToBytes32 } from '../crypto'
import { noteTag } from '../noir'
import { buildSponsoredShield } from '../soroban'
import { addNote } from '../notes'
import { toRaw } from '../amount'

/**
 * Shield a supported asset into the desk's custody. Generates fresh note secrets in-browser,
 * derives the public owner_tag via the note_tag Noir helper, submits a user-signed shield, and
 * stores the private note locally (IndexedDB).
 */
export default function ShieldForm({
  desk,
  userPubkey,
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

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const asset = desk.assets.find((a) => a.asset_id === assetId)!
      const rawAmount = toRaw(amount, asset.decimals)
      const sk = randomField()
      const rho = randomField()
      setStatus('Deriving owner tag…')
      const owner_tag = await noteTag(sk, rho)
      setStatus('Authorize in wallet…')
      const txXdr = await buildSponsoredShield(
        desk.contract_id,
        desk.sponsor_pubkey,
        userPubkey,
        assetId,
        rawAmount,
        fieldToBytes32(owner_tag),
      )
      setStatus('Submitting (sponsored)…')
      const { result } = await api.submitShield(desk.id, txXdr)
      const txHash = result
      await addNote({
        id: crypto.randomUUID(),
        deskId: desk.id,
        role: 'asset',
        asset_id: assetId,
        symbol: asset.symbol,
        amount: rawAmount,
        sk,
        rho,
        owner_tag,
        status: 'confirmed',
        txHash,
        createdAt: Date.now(),
      })
      setStatus(`Shielded (sponsored). ${result}`)
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
      <button type="submit" disabled={busy}>
        {busy ? 'Shielding…' : 'Shield'}
      </button>
      {status && <span className="muted">{status}</span>}
      {error && <span className="err">{error}</span>}
    </form>
  )
}
