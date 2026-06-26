import { useState } from 'react'
import type { ActivityEvent } from '@mosaic/sdk'
import { useActivity } from '../ActivityContext'
import type { Operation } from '../api'

const terminal = (operation: Operation) => ['succeeded', 'failed', 'cancelled'].includes(operation.status)

export default function ActivityDrawer() {
  const { operations, activities, connected, error, cancel } = useActivity()
  const [open, setOpen] = useState(false)
  const active = operations.filter((operation) => !terminal(operation))
  const activeCount = active.length + activities.filter((activity) => !terminalActivity(activity)).length
  return (
    <aside className={`activity-drawer${open ? ' open' : ''}`}>
      <button type="button" className="activity-toggle" onClick={() => setOpen((value) => !value)}>
        Activity{activeCount ? ` (${activeCount})` : ''}
      </button>
      {open && <div className="activity-panel">
        <h3>Activity</h3>
        {activities.length === 0 && <p className="muted">No recorded activity yet.</p>}
        {activities.map((activity) => {
          const txs = transactionHashes(activity)
          const contracts = contractIds(activity)
          return <div className="activity-item" key={activity.cursor ?? activity.id}>
            <div className="activity-row">
              <strong>{activityTitle(activity)}</strong>
              <span className={`activity-source ${activitySource(activity).toLowerCase()}`}>{activitySource(activity)}</span>
              {activity.status && <span className={`operation-${activity.status}`}>{activity.status.replaceAll('_', ' ')}</span>}
            </div>
            <small className="mono">{activityTime(activity)}</small>
            {txs.length > 0 && <div className="activity-transactions">
              <span className="muted">{txs.length === 1 ? 'Transaction' : 'Transactions'}</span>
              {txs.map((tx) => <a className="mono activity-tx-link" href={stellarExpertTxUrl(tx, activity)} target="_blank" rel="noreferrer" title={tx} key={tx}>tx {short(tx)}</a>)}
            </div>}
            {contracts.length > 0 && <div className="activity-contracts">
              <span className="muted">{contracts.length === 1 ? 'Contract' : 'Contracts'}</span>
              {contracts.map((contract) => <a className="mono activity-contract-link" href={stellarExpertContractUrl(contract, activity)} target="_blank" rel="noreferrer" title={contract} key={contract}>contract {short(contract)}</a>)}
            </div>}
            {activity.note_id && <small className="mono">note {short(activity.note_id)}</small>}
            {activity.message && <div className={activity.kind === 'error' ? 'err' : 'muted'}>{activity.message}</div>}
          </div>
        })}

        <h3>Operations</h3>
        {!connected && <p className="muted">Connect and authenticate the wallet to load remote operations.</p>}
        {error && <p className="err">{error}</p>}
        {operations.length === 0 && connected && <p className="muted">No operations yet.</p>}
        {operations.map((operation) => <div className="activity-item" key={operation.id}>
          <div><strong>{label(operation.kind)}</strong> <span className={`operation-${operation.status}`}>{operation.status.replaceAll('_', ' ')}</span></div>
          <small className="mono">{operation.id.slice(0, 8)}</small>
          {operation.status === 'waiting_for_client' && <div className="muted">Waiting for the unlocked private wallet…</div>}
          {operation.error && <div className="err">{operation.error}</div>}
          {!terminal(operation) && !operation.submitted && <button type="button" onClick={() => void cancel(operation.id)}>Cancel</button>}
        </div>)}
      </div>}
    </aside>
  )
}

function label(kind: Operation['kind']) {
  return ({ shield: 'Shield', place_order: 'Place order', unshield: 'Unshield', cancel_order: 'Cancel order' })[kind]
}

function terminalActivity(activity: ActivityEvent) {
  if (activity.kind === 'backend_operation') return ['succeeded', 'failed', 'cancelled'].includes(activity.status ?? '')
  if (activity.kind === 'transaction') return ['succeeded', 'failed'].includes(activity.status ?? '')
  if (activity.kind === 'error') return true
  return !['started', 'staged', 'submitted', 'queued', 'waiting_for_client', 'waiting_for_chain'].includes(activity.status ?? '')
}

function activitySource(activity: ActivityEvent): 'Local' | 'Remote' {
  return activity.kind === 'backend_operation' ? 'Remote' : 'Local'
}

function activityTitle(activity: ActivityEvent) {
  if (activity.action === 'update_wasm') return 'Update Wasm'
  if (activity.action) return title(activity.action)
  if (activity.method) return title(activity.method)
  if (activity.kind === 'backend_operation') return 'Remote operation'
  if (activity.kind === 'contract_event') return `Contract ${String(activity.status ?? 'event')}`
  if (activity.kind === 'note_indexed') return 'Note indexed'
  return title(activity.kind)
}

function title(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function short(value: string) {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value
}

function transactionHashes(activity: ActivityEvent) {
  const out = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value !== 'string') return
    if (/^(0x)?[0-9a-f]{32,}$/i.test(value) || /^[0-9a-f]{64}$/i.test(value)) out.add(value)
  }
  const visit = (value: unknown, key = '') => {
    if (typeof value === 'string') {
      if (['tx_hash', 'txHash', 'transaction', 'base_tx_hash', 'baseTxHash'].includes(key)) add(value)
      return
    }
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item))
      return
    }
    for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey)
  }
  add(activity.tx_hash)
  visit(activity.metadata)
  return [...out]
}

function contractIds(activity: ActivityEvent) {
  const out = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value === 'string' && /^C[A-Z2-7]{55}$/.test(value)) out.add(value)
  }
  const visit = (value: unknown, key = '') => {
    if (typeof value === 'string') {
      if (['contract_id', 'contractId', 'contract'].includes(key)) add(value)
      return
    }
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item))
      return
    }
    for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey)
  }
  add(activity.contract_id)
  visit(activity.metadata)
  return [...out]
}

function stellarExpertTxUrl(tx: string, activity: ActivityEvent) {
  return `https://stellar.expert/explorer/${stellarExpertNetwork(activity)}/tx/${tx.replace(/^0x/i, '')}`
}

function stellarExpertContractUrl(contract: string, activity: ActivityEvent) {
  return `https://stellar.expert/explorer/${stellarExpertNetwork(activity)}/contract/${contract}`
}

function stellarExpertNetwork(activity: ActivityEvent) {
  const network = String(activity.network ?? '').toLowerCase()
  if (network.includes('public') || network.includes('mainnet')) return 'public'
  if (network.includes('futurenet')) return 'futurenet'
  return 'testnet'
}

function activityTime(activity: ActivityEvent) {
  if (!activity.created_at) return activity.cursor ? `#${activity.cursor}` : ''
  return new Date(activity.created_at).toLocaleString()
}
