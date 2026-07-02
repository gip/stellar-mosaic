import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Address } from 'viem'
import { api, type BaseDeploymentConfig, type Desk } from '../api'
import { deployBridge, displayEth, errorMessage, estimateBridgeDeployment } from '../base'
import { useEthereumWallet } from '../EthereumWalletContext'
import { useWallet } from '../WalletContext'
import { useStorageMode } from '../StorageModeContext'
import { hasEnoughEth, pendingDeploymentKey, readPendingDeployment } from '../baseDeployment'
import { newActionId, recordDeployActivity } from '../deployActivity'

export default function BaseDeploymentPanel({
  desk,
  autoStart = false,
  actionId,
  onUpdated,
}: {
  desk: Desk
  autoStart?: boolean
  actionId?: string
  onUpdated: (desk: Desk) => void
}) {
  const ethereum = useEthereumWallet()
  const wallet = useWallet()
  const storage = useStorageMode()
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
  // One id shared by every activity event of this deployment. Reuse the caller's (so the desk
  // creation and its bridge steps group together); otherwise mint a stable one for a standalone
  // retry from the desk card.
  const groupActionId = useMemo(() => actionId ?? newActionId(), [actionId])

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
    // The bridge is only ever completed through the Trusted backend (`completeBaseDeployment`), so
    // its activity always belongs to the trusted store.
    const walletContext = { wallet_address: wallet.address ?? undefined, network: wallet.networkPassphrase ?? undefined }
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
        await recordDeployActivity('trusted', {
          kind: 'user_action', action: 'deploy_base_bridge', status: 'started',
          ...walletContext, desk_id: desk.id, contract_id: desk.contract_id,
          metadata: { action_id: groupActionId, name: desk.name, asset_ids: assetIds },
        })
        const deployed = await deployBridge({
          artifact: { abi: config.abi, bytecode: config.bytecode },
          account: ethereum.address,
          assetIds,
          tokens,
        })
        completed = { tx_hash: deployed.txHash, bridge_address: deployed.bridgeAddress }
        localStorage.setItem(pendingDeploymentKey(desk.id), JSON.stringify(completed))
        await ethereum.refreshBalance()
        await recordDeployActivity('trusted', {
          kind: 'user_action', action: 'deploy_base_bridge', status: 'succeeded',
          ...walletContext, desk_id: desk.id, contract_id: desk.contract_id, tx_hash: completed.tx_hash,
          metadata: { action_id: groupActionId, name: desk.name, bridge_address: completed.bridge_address },
        })
      }
      setStatus('Verifying the bridge and configuring the Stellar desk…')
      const updated = await api.completeBaseDeployment(desk.id, completed)
      localStorage.removeItem(pendingDeploymentKey(desk.id))
      await recordDeployActivity('trusted', {
        kind: 'user_action', action: 'configure_base_bridge', status: 'succeeded',
        ...walletContext, desk_id: desk.id, contract_id: desk.contract_id,
        metadata: { action_id: groupActionId, name: desk.name, bridge_address: completed.bridge_address },
      })
      onUpdated(updated)
      setStatus(null)
    } catch (cause) {
      await recordDeployActivity('trusted', {
        kind: 'error', action: 'deploy_base_bridge', status: 'failed',
        ...walletContext, desk_id: desk.id, contract_id: desk.contract_id,
        message: errorMessage(cause),
        metadata: { action_id: groupActionId, name: desk.name },
      })
      setError(errorMessage(cause))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }, [setup, config, ethereum, assetIds, tokens, desk.id, desk.name, desk.contract_id, groupActionId, wallet.address, wallet.networkPassphrase, onUpdated])

  // Trusted mode deploys the bridge on the server (operator sponsor key); a failed attempt is retried
  // there too, so the browser never signs.
  const runServerRetry = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      onUpdated(await api.retryBaseDeployment(desk.id))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }, [desk.id, onUpdated])

  useEffect(() => {
    if (!autoStart || started.current || !config || !setup || setup.status === 'active') return
    started.current = true
    void run()
  }, [autoStart, config, setup, run])

  if (!setup) return null
  const active = setup.status === 'active'

  if (storage.mode === 'trusted') {
    return (
      <div className="base-deployment">
        <strong>Base Sepolia bridge</strong>
        <div className="muted">
          {active
            ? <>Active · <span className="mono">{setup.bridge_address}</span></>
            : `Setup ${setup.status.replace('_', ' ')} · deployed by the server`}
        </div>
        <div className="muted">Assets: {setup.assets.map((asset) => `${asset.symbol} (#${asset.asset_id})`).join(', ')}</div>
        {!active && (
          <>
            {setup.error && <p className="err">{setup.error}</p>}
            <button type="button" disabled={busy} onClick={() => void runServerRetry()}>
              {busy ? 'Deploying…' : 'Retry bridge deployment'}
            </button>
          </>
        )}
        {error && <p className="err">{error}</p>}
      </div>
    )
  }
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
