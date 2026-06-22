import { useState } from 'react'
import { api, type CatalogAsset } from '../api'
import { useWallet } from '../WalletContext'

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : addr
}

function chainName(id: number | null): string {
  if (id === 84532) return 'Base Sepolia'
  return id === null ? '' : `chain ${id}`
}

/** Renders the asset catalog as cards, each with its cross-chain sides, proposer, trust count, and
 * a trust/untrust toggle. Defaults are always trusted and cannot be toggled. */
export default function AssetList({
  assets,
  onChange,
}: {
  assets: CatalogAsset[]
  onChange: () => void
}) {
  const { address } = useWallet()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function toggle(a: CatalogAsset) {
    setBusy(a.id)
    setError(null)
    try {
      if (a.trusted_by_me) await api.untrustAsset(a.id)
      else await api.trustAsset(a.id)
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (assets.length === 0) return <p className="muted">No assets yet.</p>

  return (
    <>
      {error && <p className="err">{error}</p>}
      {assets.map((a) => (
        <div className="card" key={a.id}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h3 style={{ margin: 0 }}>
              {a.symbol}{' '}
              {a.is_default && <span className="pill">Built-in</span>}
            </h3>
            <span className="muted">
              {a.trust_count} {a.trust_count === 1 ? 'trust' : 'trusts'}
            </span>
          </div>

          <div className="row" style={{ marginTop: 8 }}>
            {a.stellar_token && (
              <div>
                <label style={{ margin: 0 }}>Stellar</label>
                <div className="mono">
                  {a.stellar_token === 'native' ? 'XLM (native)' : a.stellar_token}
                </div>
                <div className="muted">{a.stellar_decimals} decimals</div>
              </div>
            )}
            {a.base_token && (
              <div>
                <label style={{ margin: 0 }}>Base</label>
                <div className="mono">
                  {a.base_token === 'native' ? 'ETH (native)' : a.base_token}
                </div>
                <div className="muted">
                  {chainName(a.base_chain_id)} · {a.base_decimals} decimals
                </div>
              </div>
            )}
          </div>
          {a.stellar_token && a.base_token && (
            <div className="muted" style={{ marginTop: 4 }}>
              Bridged 1:1 between Stellar and Base.
            </div>
          )}

          <div className="row" style={{ marginTop: 10, alignItems: 'center' }}>
            <span className="muted">
              Proposed by{' '}
              {a.proposer_address ? (
                <span className="mono" title={a.proposer_address}>
                  {short(a.proposer_address)}
                </span>
              ) : (
                'the protocol'
              )}
            </span>
            {!a.is_default && (
              <button
                type="button"
                onClick={() => toggle(a)}
                disabled={!address || busy === a.id}
                title={address ? undefined : 'Connect your wallet to trust assets'}
              >
                {busy === a.id ? '…' : a.trusted_by_me ? 'Untrust' : 'Trust'}
              </button>
            )}
            {a.is_default && <span className="muted">· trusted by default</span>}
          </div>
        </div>
      ))}
    </>
  )
}
