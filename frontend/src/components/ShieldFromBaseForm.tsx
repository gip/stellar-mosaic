import { useEffect, useMemo, useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { bytesToHex } from 'viem'
import { api, type BaseShieldConfig, type BaseShieldJob, type Desk } from '../api'
import { toRaw } from '../amount'
import { randomField, fieldToBytes32 } from '../crypto'
import { noteTag } from '../noir'
import { addNote } from '../notes'
import { baseShield } from '../base'
import { useRecovery } from '../RecoveryContext'
import { useEthereumWallet } from '../EthereumWalletContext'
import Field from './ui/Field'
import ProgressSteps from './ui/ProgressSteps'

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
  disabledReason,
  onDone,
}: {
  desk: Desk
  userPubkey: string | null
  disabledReason?: string | null
  onDone: () => void
}) {
  const [assetId, setAssetId] = useState(desk.assets[0]?.asset_id ?? 1)
  const [amount, setAmount] = useState('1')
  // Symbols of catalog assets that have a Base side; only these can be shielded from Base.
  const [baseSymbols, setBaseSymbols] = useState<Set<string> | null>(null)
  const [config, setConfig] = useState<BaseShieldConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<BaseShieldJob | null>(null)
  const recovery = useRecovery()
  const ethereum = useEthereumWallet()
  const recoveryReady = recovery.unlocked && !recovery.error

  useEffect(() => {
    if (disabledReason) {
      return
    }
    let active = true
    api
      .getBaseShieldConfig(desk.id)
      .then((value) => {
        if (!active) return
        setConfig(value)
        setConfigError(null)
      })
      .catch((cause) => {
        if (!active) return
        setConfig(null)
        setConfigError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
    }
  }, [desk.id, disabledReason])

  // Load which assets exist on Base (per the catalog) and restrict the picker to those.
  useEffect(() => {
    let active = true
    api
      .listCatalogAssets('trusted')
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

  // Derive a valid selection after the catalog loads instead of synchronizing derived state in an
  // effect. The explicit selection remains stable whenever it is still eligible.
  const selectedAssetId = baseAssets.some((a) => a.asset_id === assetId)
    ? assetId
    : (baseAssets[0]?.asset_id ?? -1)

  const selectedAsset = baseAssets.find((a) => a.asset_id === selectedAssetId)
  const amountError = (() => {
    if (amount.trim() === '' || !selectedAsset) return null
    try {
      return BigInt(toRaw(amount, selectedAsset.decimals)) > 0n ? null : 'Amount must be greater than zero.'
    } catch {
      return `Enter a valid amount with at most ${selectedAsset.decimals} decimal places.`
    }
  })()

  // The backend job is mid-flight until it reaches a terminal state.
  const jobRunning = !!job && job.status !== 'active' && job.status !== 'failed'

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
      if (disabledReason) throw new Error(disabledReason)
      if (!config?.available || !config.bridge) {
        throw new Error('Base shielding is not available for this desk.')
      }
      const addr = config.bridge
      const asset = baseAssets.find((a) => a.asset_id === selectedAssetId)
      if (!asset) throw new Error('Pick an asset that is available on Base.')
      const rawAmount = toRaw(amount, asset.decimals)

      if (!ethereum.address || !ethereum.connectedToBase) {
        throw new Error('Connect Ethereum on Base Sepolia in the header first.')
      }
      const account = ethereum.address

      setStatus('Deriving note…')
      const sk = randomField()
      const rho = randomField()
      const owner_tag = await noteTag(sk, rho)
      const ownerTagHex = bytesToHex(fieldToBytes32(owner_tag))

      setStatus('Approve + shield on Base (sign in your wallet)…')
      const { depositId } = await baseShield({
        bridge: addr as `0x${string}`,
        assetId: selectedAssetId,
        amount: BigInt(rawAmount),
        ownerTag: ownerTagHex,
        account,
      })

      // Persist the private note locally; it becomes spendable once the worker mints it and the
      // indexer reconciles it by owner_tag (stamping its leaf_index).
      await addNote('trusted', {
        id: crypto.randomUUID(),
        deskId: desk.id,
        role: 'asset',
        asset_id: selectedAssetId,
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
      const created = await api.enqueueBaseShield(desk.id, {
        expected_bridge: addr,
        deposit_id: depositId,
      })
      setJobId(created.id)
      setJob(created)
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <p className="muted" style={{ margin: 0 }}>
        Lock an asset on Base Sepolia and mint the matching private note on Stellar via a zero-knowledge
        proof. Proving + finality (~10–15 min) run on the backend; the note appears here once minted.
      </p>
      <div className="muted">
        Network: <strong>Base Sepolia</strong>
        {config?.bridge && (
          <>
            {' '}· Verified bridge: <span className="mono">{config.bridge}</span>
          </>
        )}
      </div>
      {config?.reason === 'contract_unconfigured' && (
        <span className="err">This desk has no Base bridge configured on Stellar.</span>
      )}
      {config?.reason === 'worker_disabled' && (
        <span className="err">The Base proving service is not available.</span>
      )}
      {configError && <span className="err">Could not verify Base configuration: {configError}</span>}
      {baseSymbols && baseAssets.length === 0 ? (
        <span className="muted">None of this desk’s assets are available on Base.</span>
      ) : (
        <>
          <Field id="baseshield-asset" label="Asset">
            <select value={selectedAssetId} onChange={(e) => setAssetId(Number(e.target.value))}>
              {baseAssets.map((a) => (
                <option key={a.asset_id} value={a.asset_id}>
                  {a.symbol}
                </option>
              ))}
            </select>
          </Field>
          <Field id="baseshield-amount" label={`Amount (${selectedAsset?.symbol ?? ''})`} error={amountError}>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <button
            className="btn-primary btn-block"
            type="submit"
            disabled={
              busy ||
              !recoveryReady ||
              !baseSymbols ||
              !!disabledReason ||
              !ethereum.connectedToBase ||
              !config?.available ||
              !!amountError
            }
          >
            {busy
              ? 'Working…'
              : !ethereum.connectedToBase
                ? 'Connect Base Sepolia wallet first'
              : disabledReason
                ? 'Waiting for contract verification'
                : !config?.available
                  ? 'Base shielding unavailable'
                  : recoveryReady
                    ? 'Shield from Base'
                    : 'Enable / repair recovery first'}
          </button>
        </>
      )}
      <ProgressSteps
        running={busy || jobRunning}
        step={jobRunning && job ? STATUS_LABEL[job.status] ?? job.status : status}
        hint="Base proving + finality run on the backend (~10–15 min). You can leave this page."
      />
      {error && <div className="banner err" role="alert">{error}</div>}
      {job && !jobRunning && (
        <div className={`status-dot ${job.status === 'active' ? 'ok' : 'err'}`}>
          Deposit #{job.deposit_id}: {STATUS_LABEL[job.status] ?? job.status}
          {job.status === 'failed' && job.error ? ` — ${job.error}` : ''}
        </div>
      )}
    </form>
  )
}
