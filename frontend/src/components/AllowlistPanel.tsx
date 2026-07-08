import { useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { StrKey } from '@stellar/stellar-sdk'
import type { Address } from 'viem'
import { api, type Desk } from '../api'
import { addAllowedTrustless } from '../trustless'
import { baseBridgeAddAllowed, connectBase } from '../base'
import { newActionId, recordDeployActivity } from '../deployActivity'
import Field from './ui/Field'
import Button from './ui/Button'

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** Desk-owner allowlist management for a permissioned desk. One input accepts either a Stellar
 * G… member or (when the desk has an active Base bridge) a Base 0x… member. Add-only by design —
 * there is no removal, because a removed member's shielded notes would be stranded behind the
 * unshield recipient gate. */
export default function AllowlistPanel({
  desk,
  walletAddress,
  trustless,
  onAdded,
}: {
  desk: Desk
  walletAddress: string
  trustless: boolean
  onAdded?: () => void
}) {
  const [member, setMember] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const bridge = desk.base_deployment?.status === 'active' ? desk.base_deployment.bridge_address : null
  const value = member.trim()
  const isStellar = StrKey.isValidEd25519PublicKey(value)
  const isEvm = EVM_ADDRESS.test(value)
  const memberError =
    value === '' || isStellar || (isEvm && bridge)
      ? null
      : isEvm
        ? 'This desk has no active Base bridge to add 0x… members to.'
        : `Enter a valid Stellar G… account${bridge ? ' or Base 0x… address' : ''}.`

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (memberError || value === '') return
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      if (trustless) {
        if (isStellar) {
          const { txHash } = await addAllowedTrustless(desk, { address: walletAddress, member: value })
          setStatus(`Allowed ${short(value)} (tx ${txHash.slice(0, 8)}…)`)
        } else {
          const deployer = desk.base_deployment?.deployer_address
          const account = await connectBase()
          if (deployer && account.toLowerCase() !== deployer.toLowerCase()) {
            throw new Error(`Connect the bridge owner wallet ${deployer} in your EVM wallet first.`)
          }
          // The Stellar leg's activity is recorded by the SDK client; this MetaMask-signed Base leg
          // bypasses the SDK, so the browser records it itself (best-effort, like deploys).
          const actionId = newActionId()
          try {
            const txHash = await baseBridgeAddAllowed(bridge as Address, value as Address, account)
            await recordDeployActivity('trustless', {
              kind: 'user_action', action: 'add_allowed', status: 'succeeded',
              wallet_address: walletAddress, desk_id: desk.id, tx_hash: txHash,
              metadata: { action_id: actionId, member: value, chain: 'base', bridge_address: bridge },
            })
            setStatus(`Allowed ${short(value)} on the Base bridge (tx ${txHash.slice(0, 8)}…)`)
          } catch (cause) {
            await recordDeployActivity('trustless', {
              kind: 'error', action: 'add_allowed', status: 'failed',
              wallet_address: walletAddress, desk_id: desk.id, message: errorMessage(cause),
              metadata: { action_id: actionId, member: value, chain: 'base', bridge_address: bridge },
            })
            throw cause
          }
        }
      } else {
        await api.addDeskAllowed(desk.id, isStellar ? { stellar_members: [value] } : { evm_members: [value] })
        setStatus(`Allowed ${short(value)}${isEvm ? ' on the Base bridge' : ''}.`)
      }
      setMember('')
      onAdded?.()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <p className="muted">
        Only allowlisted addresses can shield and unshield. Adding is permanent — members cannot be
        removed (their shielded notes would be stranded).
      </p>
      <Field
        id="allowlist-member"
        label="Add member"
        help={bridge ? 'Stellar G… account, or 0x… address for Base deposits.' : 'Stellar G… account.'}
        error={memberError}
      >
        <div className="field-row">
          <input
            className="mono"
            value={member}
            onChange={(e) => setMember(e.target.value)}
            placeholder={bridge ? 'G… or 0x…' : 'G…'}
            style={{ flex: 1 }}
          />
          <Button size="sm" type="submit" disabled={busy || value === '' || !!memberError}>
            {busy ? 'Adding…' : 'Add'}
          </Button>
        </div>
      </Field>
      {status && !error && <div className="status-dot ok">{status}</div>}
      {error && <div className="banner err" role="alert">{error}</div>}
    </form>
  )
}
