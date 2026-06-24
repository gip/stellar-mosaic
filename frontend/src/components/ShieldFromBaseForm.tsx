import { useEffect, useMemo, useState } from 'react'
import { bytesToHex } from 'viem'
import { api, type BaseShieldJob, type Desk } from '../api'
import { toRaw } from '../amount'
import { randomField, fieldToBytes32 } from '../crypto'
import { noteTag } from '../noir'
import { addNote } from '../notes'
import { baseShield, connectBase } from '../base'
import { useRecovery } from '../RecoveryContext'

const BRIDGE_KEY = 'mosaic.baseBridge'

const STATUS_LABEL: Record<string, string> = {
  proving: 'Proving the deposit (Groth16)…',
  awaiting_finality: 'Waiting for Base finality…',
  minting: 'Verifying on Stellar + minting…',
  active: 'Active — note minted ✓',
  failed: 'Failed',
}

/**
 * Shield an asset from BASE Sepolia: lock it in the Base MosaicBridge with a freshly-derived
 * owner_tag (same derivation as a native shield, so the minted Stellar note reconciles by owner_tag
 * and is spendable), then hand the deposit to the backend worker (prove -> finalize -> mint) and
 * track its status.
 */
export default function ShieldFromBaseForm({
  desk,
  userPubkey,
  onDone,
}: {
  desk: Desk
  userPubkey: string | null
  onDone: () => void
}) {
  const [bridge, setBridge] = useState(() => localStorage.getItem(BRIDGE_KEY) ?? '')
  const [assetId, setAssetId] = useState(desk.assets[0]?.asset_id ?? 1)
  const [amount, setAmount] = useState('1')
  // Symbols of catalog assets that have a Base side; only these can be shielded from Base.
  const [baseSymbols, setBaseSymbols] = useState<Set<string> | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<BaseShieldJob | null>(null)
  const recovery = useRecovery()
  const recoveryReady = recovery.unlocked && !recovery.error

  // Load which assets exist on Base (per the catalog) and restrict the picker to those.
  useEffect(() => {
    let active = true
    api
      .listCatalogAssets()
      .then((all) => {
        if (active)
          setBaseSymbols(
            new Set(all.filter((c) => c.base_token).map((c) => c.symbol.toUpperCase())),
          )
      })
      .catch(() => active && setBaseSymbols(new Set()))
    return () => {
      active = false
    }
  }, [])

  const baseAssets = useMemo(
    () => (baseSymbols ? desk.assets.filter((a) => baseSymbols.has(a.symbol.toUpperCase())) : []),
    [baseSymbols, desk.assets],
  )

  // Keep the selection on a Base-eligible asset once the catalog has loaded. Adjusting state while
  // rendering (guarded so it can't loop) is React's recommended alternative to a setState effect for
  // "fix some state when a derived value changes".
  if (baseSymbols && !baseAssets.some((a) => a.asset_id === assetId)) {
    setAssetId(baseAssets[0]?.asset_id ?? -1)
  }

  // Poll the backend job until it reaches a terminal state.
  useEffect(() => {
    if (!jobId) return
    let stopped = false
    const tick = async () => {
      try {
        const jobs = await api.listBaseShields(desk.id)
        const j = jobs.find((x) => x.id === jobId)
        if (j) {
          setJob(j)
          if (j.status === 'active' || j.status === 'failed') stopped = true
        }
      } catch {
        /* transient; keep polling */
      }
    }
    void tick()
    const iv = setInterval(() => {
      if (stopped) clearInterval(iv)
      else void tick()
    }, 4000)
    return () => clearInterval(iv)
  }, [jobId, desk.id])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setJob(null)
    setJobId(null)
    try {
      const addr = bridge.trim()
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error('Enter the Base MosaicBridge address (0x…).')
      localStorage.setItem(BRIDGE_KEY, addr)
      const asset = baseAssets.find((a) => a.asset_id === assetId)
      if (!asset) throw new Error('Pick an asset that is available on Base.')
      const rawAmount = toRaw(amount, asset.decimals)

      setStatus('Connecting Base wallet…')
      const account = await connectBase()

      setStatus('Deriving note…')
      const sk = randomField()
      const rho = randomField()
      const owner_tag = await noteTag(sk, rho)
      const ownerTagHex = bytesToHex(fieldToBytes32(owner_tag))

      setStatus('Approve + shield on Base (sign in your wallet)…')
      const { depositId } = await baseShield({
        bridge: addr as `0x${string}`,
        assetId,
        amount: BigInt(rawAmount),
        ownerTag: ownerTagHex,
        account,
      })

      // Persist the private note locally; it becomes spendable once the worker mints it and the
      // indexer reconciles it by owner_tag (stamping its leaf_index).
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
        status: 'active',
        indexed: false,
        createdAt: Date.now(),
        wallet_address: userPubkey ?? undefined,
      })

      setStatus(`Queued deposit #${depositId} — proving + minting on the backend…`)
      const created = await api.enqueueBaseShield(desk.id, { bridge: addr, deposit_id: depositId })
      setJobId(created.id)
      setJob(created)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <form onSubmit={submit} className="col" style={{ gap: 12 }}>
      <p className="muted" style={{ margin: 0 }}>
        Lock an asset on Base Sepolia and mint the matching private note on Stellar via a zero-knowledge
        proof. Proving + finality (~10–15 min) run on the backend; the note appears here once minted.
      </p>
      <div>
        <label>Base bridge address</label>
        <input
          value={bridge}
          onChange={(e) => setBridge(e.target.value)}
          placeholder="0x… (deployed MosaicBridge on Base Sepolia)"
          spellCheck={false}
        />
      </div>
      {baseSymbols && baseAssets.length === 0 ? (
        <span className="muted">None of this desk’s assets are available on Base.</span>
      ) : (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div>
            <label>Asset</label>
            <select value={assetId} onChange={(e) => setAssetId(Number(e.target.value))}>
              {baseAssets.map((a) => (
                <option key={a.asset_id} value={a.asset_id}>
                  {a.symbol}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Amount ({baseAssets.find((a) => a.asset_id === assetId)?.symbol ?? ''})</label>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </div>
          <button type="submit" disabled={busy || !recoveryReady || !baseSymbols}>
            {busy ? 'Working…' : recoveryReady ? 'Shield from Base' : 'Enable / repair recovery first'}
          </button>
        </div>
      )}
      {status && <span className="muted">{status}</span>}
      {error && <span className="err">{error}</span>}
      {job && (
        <div className="muted" style={{ fontSize: 13 }}>
          Deposit #{job.deposit_id}: <strong>{STATUS_LABEL[job.status] ?? job.status}</strong>
          {job.block_number ? ` · block ${job.block_number}` : ''}
          {job.status === 'failed' && job.error ? ` — ${job.error}` : ''}
        </div>
      )}
    </form>
  )
}
