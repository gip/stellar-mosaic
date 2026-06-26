import { useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { api } from '../api'

const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

type StellarType = 'native' | 'issued' | 'contract' | 'represented'
type BaseType = 'native' | 'erc20'

/**
 * Propose a new catalog asset. An asset can live on Stellar, Base, or both — when on both, the two
 * sides represent the same asset bridged 1:1. "Native" is fixed: XLM on Stellar, ETH on Base.
 *
 * This is metadata only — it records the cross-chain definition so a desk deployment can register
 * matching asset ids on both chains. It does not touch any chain.
 */
export default function AddAssetForm({ onDone }: { onDone: () => void }) {
  const [onStellar, setOnStellar] = useState(true)
  const [onBase, setOnBase] = useState(false)
  const [symbol, setSymbol] = useState('')

  const [stellarType, setStellarType] = useState<StellarType>('native')
  const [stellarToken, setStellarToken] = useState('')
  const [stellarDecimals, setStellarDecimals] = useState('7')

  const [baseType, setBaseType] = useState<BaseType>('native')
  const [baseChainId, setBaseChainId] = useState('84532')
  const [baseToken, setBaseToken] = useState('')
  const [baseDecimals, setBaseDecimals] = useState('6')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Native is fixed to XLM/ETH; when an asset is native on exactly one chain its symbol is locked.
  const lockedSymbol =
    onStellar && stellarType === 'native' && !onBase
      ? 'XLM'
      : onBase && baseType === 'native' && !onStellar
        ? 'ETH'
        : null
  const effectiveSymbol = lockedSymbol ?? symbol

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (!onStellar && !onBase) throw new Error('Add the asset on Stellar, Base, or both.')
      if (onStellar && stellarType === 'represented' && !onBase) {
        throw new Error('A represented Stellar asset must also be on Base (it is Base-backed).')
      }
      const body: Parameters<typeof api.proposeAsset>[0] = { symbol: effectiveSymbol }
      if (onStellar) {
        body.stellar_token =
          stellarType === 'native'
            ? 'native'
            : stellarType === 'represented'
              ? 'represented'
              : stellarToken
        body.stellar_decimals =
          stellarType === 'native' ? 7 : Number(stellarDecimals)
      }
      if (onBase) {
        body.base_chain_id = Number(baseChainId)
        body.base_token = baseType === 'native' ? 'native' : baseToken
        body.base_decimals = baseType === 'native' ? 18 : Number(baseDecimals)
      }
      await api.proposeAsset(body)
      setSymbol('')
      setStellarToken('')
      setBaseToken('')
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 560 }}>
      <label>Symbol</label>
      <input
        value={effectiveSymbol}
        onChange={(e) => setSymbol(e.target.value)}
        disabled={!!lockedSymbol}
        required
        placeholder="USDC"
      />

      <label style={{ marginTop: 12 }}>
        <input
          type="checkbox"
          checked={onStellar}
          onChange={(e) => setOnStellar(e.target.checked)}
          style={{ marginRight: 6 }}
        />
        On Stellar
      </label>

      {onStellar && (
        <div className="card" style={{ marginTop: 8 }}>
          <label>Token type</label>
          <select value={stellarType} onChange={(e) => setStellarType(e.target.value as StellarType)}>
            <option value="native">Native (XLM)</option>
            <option value="issued">Classic asset (CODE:ISSUER)</option>
            <option value="contract">Contract (C…)</option>
            <option value="represented">Represented (Base-backed, trade-only)</option>
          </select>
          {stellarType === 'represented' && (
            <p className="muted">
              No Stellar token: this asset lives on Base and exists on Stellar only as a trade-only
              note. Requires a Base side below.
            </p>
          )}
          {(stellarType === 'issued' || stellarType === 'contract') && (
            <>
              <label>{stellarType === 'issued' ? 'CODE:ISSUER' : 'Contract id (C…)'}</label>
              <input
                className="mono"
                value={stellarToken}
                onChange={(e) => setStellarToken(e.target.value)}
                required
                placeholder={
                  stellarType === 'issued'
                    ? 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
                    : 'C…'
                }
                style={{ width: '100%' }}
              />
              <label>Stellar decimals</label>
              <input
                type="number"
                value={stellarDecimals}
                onChange={(e) => setStellarDecimals(e.target.value)}
                min={0}
                max={18}
              />
            </>
          )}
        </div>
      )}

      <label style={{ marginTop: 12 }}>
        <input
          type="checkbox"
          checked={onBase}
          onChange={(e) => setOnBase(e.target.checked)}
          style={{ marginRight: 6 }}
        />
        On Base
      </label>

      {onBase && (
        <div className="card" style={{ marginTop: 8 }}>
          <label>Token type</label>
          <select value={baseType} onChange={(e) => setBaseType(e.target.value as BaseType)}>
            <option value="native">Native (ETH)</option>
            <option value="erc20">ERC20</option>
          </select>
          <label>Base chain id</label>
          <input type="number" value={baseChainId} onChange={(e) => setBaseChainId(e.target.value)} />
          {baseType === 'erc20' && (
            <>
              <label>Base ERC20 address</label>
              <input
                className="mono"
                value={baseToken}
                onChange={(e) => setBaseToken(e.target.value)}
                required
                placeholder={BASE_SEPOLIA_USDC}
                style={{ width: '100%' }}
              />
              <label>Base decimals</label>
              <input
                type="number"
                value={baseDecimals}
                onChange={(e) => setBaseDecimals(e.target.value)}
                min={0}
                max={18}
              />
              <p>
                <button
                  type="button"
                  onClick={() => {
                    setBaseChainId('84532')
                    setBaseToken(BASE_SEPOLIA_USDC)
                    setBaseDecimals('6')
                  }}
                >
                  Use Base Sepolia USDC
                </button>
              </p>
            </>
          )}
        </div>
      )}

      {onStellar && onBase && (
        <p className="muted">Added on both chains — the two sides are bridged 1:1.</p>
      )}

      {error && <p className="err">{error}</p>}
      <p>
        <button type="submit" disabled={busy}>
          {busy ? 'Adding…' : 'Add asset'}
        </button>
      </p>
    </form>
  )
}
