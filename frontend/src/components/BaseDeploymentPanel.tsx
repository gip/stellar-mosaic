import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Address } from 'viem'
import { api, type BaseDeploymentConfig, type Desk } from '../api'
import { deployBridge, displayEth, errorMessage, estimateBridgeDeployment } from '../base'
import { useEthereumWallet } from '../EthereumWalletContext'
import { hasEnoughEth, pendingDeploymentKey, readPendingDeployment } from '../baseDeployment'

export default function BaseDeploymentPanel({
  desk,
  autoStart = false,
  onUpdated,
}: {
  desk: Desk
  autoStart?: boolean
  onUpdated: (desk: Desk) => void
}) {
  const ethereum = useEthereumWallet()
  const setup = desk.base_deployment
  const [config, setConfig] = useState<BaseDeploymentConfig | null>(null)
  const [estimate, setEstimate] = useState<bigint | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  const tokens = useMemo(
    () => setup?.assets.map((asset) => asset.token as Address) ?? [],
    [setup?.assets],
  )
  const assetIds = useMemo(
    () => setup?.assets.map((asset) => asset.asset_id) ?? [],
    [setup?.assets],
  )

  useEffect(() => {
    api.getBaseDeploymentConfig().then(setConfig).catch((cause) => {
      setError(errorMessage(cause))
    })
  }, [])

  useEffect(() => {
    if (!setup || !config?.available || !config.abi || !config.bytecode || !ethereum.address || !ethereum.connectedToBase) {
      return
    }
    estimateBridgeDeployment({
      artifact: { abi: config.abi, bytecode: config.bytecode },
      account: ethereum.address,
      assetIds,
      tokens,
    }).then((value) => setEstimate(value.maxFee)).catch(() => setEstimate(null))
  }, [setup, config, ethereum.address, ethereum.connectedToBase, assetIds, tokens])

  const run = useCallback(async () => {
    if (!setup) return
    setBusy(true)
    setError(null)
    try {
      if (!config?.available || !config.abi || !config.bytecode) {
        throw new Error(config?.reason ?? 'Base deployment is not available.')
      }
      if (!ethereum.address || !ethereum.connectedToBase) {
        throw new Error('Connect the deployment wallet on Base Sepolia first.')
      }
      if (ethereum.address.toLowerCase() !== setup.deployer_address.toLowerCase()) {
        throw new Error(`Reconnect the original deployment wallet ${setup.deployer_address}.`)
      }

      let completed = setup.tx_hash && setup.bridge_address
        ? { tx_hash: setup.tx_hash, bridge_address: setup.bridge_address }
        : readPendingDeployment(localStorage, desk.id)
      if (!completed) {
        const freshEstimate = await estimateBridgeDeployment({
          artifact: { abi: config.abi, bytecode: config.bytecode },
          account: ethereum.address,
          assetIds,
          tokens,
        })
        if (ethereum.balance === null || ethereum.balance < freshEstimate.maxFee) {
          throw new Error(`Insufficient Base Sepolia ETH. Estimated maximum fee: ${displayEth(freshEstimate.maxFee)} ETH.`)
        }
        setStatus('Confirm the Base Sepolia deployment in MetaMask…')
        const deployed = await deployBridge({
          artifact: { abi: config.abi, bytecode: config.bytecode },
          account: ethereum.address,
          assetIds,
          tokens,
        })
        completed = { tx_hash: deployed.txHash, bridge_address: deployed.bridgeAddress }
        localStorage.setItem(pendingDeploymentKey(desk.id), JSON.stringify(completed))
        await ethereum.refreshBalance()
      }
      setStatus('Verifying the bridge and configuring the Stellar desk…')
      const updated = await api.completeBaseDeployment(desk.id, completed)
      localStorage.removeItem(pendingDeploymentKey(desk.id))
      onUpdated(updated)
      setStatus(null)
    } catch (cause) {
      setError(errorMessage(cause))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }, [setup, config, ethereum, assetIds, tokens, desk.id, onUpdated])

  useEffect(() => {
    if (!autoStart || started.current || !config || !setup || setup.status === 'active') return
    started.current = true
    void run()
  }, [autoStart, config, setup, run])

  if (!setup) return null
  const active = setup.status === 'active'
  const effectiveEstimate = ethereum.connectedToBase && config?.available ? estimate : null
  const insufficient = effectiveEstimate !== null && !hasEnoughEth(ethereum.balance, effectiveEstimate)

  return (
    <div className="base-deployment">
      <strong>Base Sepolia bridge</strong>
      <div className="muted">
        {active
          ? <>Active · <span className="mono">{setup.bridge_address}</span></>
          : `Setup ${setup.status.replace('_', ' ')} · paid by ${setup.deployer_address}`}
      </div>
      <div className="muted">Assets: {setup.assets.map((asset) => `${asset.symbol} (#${asset.asset_id})`).join(', ')}</div>
      {!active && (
        <>
          <p className="warn">Deployment requires Base Sepolia ETH for gas and is paid directly from MetaMask.</p>
          {ethereum.balance !== null && <div>Balance: {displayEth(ethereum.balance)} ETH</div>}
          {effectiveEstimate !== null && <div>Estimated maximum fee: {displayEth(effectiveEstimate)} ETH</div>}
          <button type="button" disabled={busy || insufficient || !ethereum.connectedToBase} onClick={() => void run()}>
            {busy ? 'Working…' : setup.tx_hash || readPendingDeployment(localStorage, desk.id) ? 'Retry Stellar configuration' : 'Deploy bridge on Base Sepolia'}
          </button>
        </>
      )}
      {status && <p className="muted">{status}</p>}
      {(error || setup.error) && <p className="err">{error ?? setup.error}</p>}
    </div>
  )
}
