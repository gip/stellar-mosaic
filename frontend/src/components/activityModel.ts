import type { ActivityEvent } from '@mosaic/sdk'
import type { Operation } from '../api'
import { formatAmount, formatPrice } from '../amount'

export type ActivityAction = 'Deploy' | 'Shield' | 'Unshield' | 'Place Order' | 'Cancel Order'

export interface TransactionLine {
  id: string
  tx?: string
  activity?: ActivityEvent
  status?: string
  label: string
  createdAt?: number
}

export interface ActivityGroup {
  id: string
  action: ActivityAction
  summary: string
  status?: string
  createdAt?: number
  lines: TransactionLine[]
}

export function activityGroups(activities: ActivityEvent[], operations: Operation[]): ActivityGroup[] {
  const operationById = new Map(operations.map((operation) => [operation.id, operation]))
  const txGroups = new Map<string, { key: string; action: ActivityAction }>()
  const groups: ActivityGroup[] = []
  const groupByKey = new Map<string, ActivityGroup>()
  const activityByGroup = new Map<string, ActivityEvent[]>()

  const addGroup = (key: string, action: ActivityAction) => {
    const existing = groupByKey.get(key)
    if (existing) return existing
    const group: ActivityGroup = { id: key, action, summary: '', lines: [] }
    groupByKey.set(key, group)
    groups.push(group)
    return group
  }

  for (const activity of activities) {
    const action = directAction(activity, operationById)
    if (!action) continue
    const key = directGroupKey(activity)
    if (!key) continue
    const existing = activityByGroup.get(key) ?? []
    existing.push(activity)
    activityByGroup.set(key, existing)
    for (const tx of transactionHashes(activity)) txGroups.set(tx, { key, action })
  }

  activities.forEach((activity, index) => {
    const txs = transactionHashes(activity)
    const linkedGroup = txs.map((tx) => txGroups.get(tx)).find(Boolean)
    const action = directAction(activity, operationById) ?? linkedGroup?.action
    if (!action) return
    const key = directGroupKey(activity) ?? linkedGroup?.key ?? (txs[0] ? `tx:${txs[0]}` : `activity:${activity.cursor ?? activity.id ?? index}`)
    const group = addGroup(key, action)
    if (!activityByGroup.has(key)) activityByGroup.set(key, [])
    if (!activityByGroup.get(key)?.includes(activity)) activityByGroup.get(key)?.push(activity)
    for (const tx of txs) {
      upsertTxLine(group, {
        id: `${String(activity.cursor ?? activity.id ?? `activity-${index}`)}:${tx}`,
        tx,
        activity,
        status: txStatus(activity),
        label: txLabel(activity),
        createdAt: activity.created_at,
      })
    }
  })

  for (const operation of operations) {
    const key = `operation:${operation.id}`
    const group = addGroup(key, actionForOperationKind(operation.kind))
    group.status = operation.status
    group.summary = summaryForOperation(operation, activityByGroup.get(key) ?? [])
    group.createdAt = operation.updated_at ?? operation.created_at
  }

  for (const group of groups) {
    const operationId = group.id.startsWith('operation:') ? group.id.slice('operation:'.length) : undefined
    const operation = operationId ? operationById.get(operationId) : undefined
    const groupActivities = activityByGroup.get(group.id) ?? []
    group.status = displayStatus(operation?.status ?? latestStatus(groupActivities))
    group.summary ||= operation ? summaryForOperation(operation, groupActivities) : summaryForActivities(group.action, groupActivities)
    group.createdAt = Math.max(
      operation?.updated_at ?? operation?.created_at ?? 0,
      ...groupActivities.map((activity) => activity.created_at ?? 0),
      ...group.lines.map((line) => line.createdAt ?? 0),
    ) || undefined
    group.lines.sort((a, b) => statusRank(a.status) - statusRank(b.status))
  }

  return groups
}

function upsertTxLine(group: ActivityGroup, line: TransactionLine) {
  const existing = line.tx ? group.lines.find((item) => item.tx === line.tx) : undefined
  if (!existing) {
    group.lines.push(line)
    return
  }
  if (statusRank(line.status) >= statusRank(existing.status)) existing.status = line.status
  existing.activity = line.activity ?? existing.activity
  existing.label = line.label
  existing.createdAt = Math.max(existing.createdAt ?? 0, line.createdAt ?? 0) || existing.createdAt
}

export function terminalStatus(status?: string) {
  if (!status) return true
  return !['started', 'staged', 'prepared', 'submitted', 'queued', 'running', 'waiting_for_client', 'waiting_for_chain'].includes(status)
}

export function displayStatus(status?: string) {
  if (status === 'waiting_for_client' || status === 'waiting_for_chain' || status === 'queued' || status === 'started' || status === 'staged' || status === 'submitted' || status === 'prepared') return 'running'
  return status
}

function directAction(activity: ActivityEvent, operationById: Map<string, Operation>): ActivityAction | undefined {
  if (activity.operation_id) {
    const operation = operationById.get(activity.operation_id)
    if (operation) return actionForOperationKind(operation.kind)
  }
  const detailKind = metadataString(activity.metadata, ['kind'])
  if (detailKind) {
    const action = actionForValue(detailKind)
    if (action) return action
  }
  return actionForValue(activity.action) ?? actionForValue(activity.method)
}

function directGroupKey(activity: ActivityEvent): string | undefined {
  if (activity.operation_id) return `operation:${activity.operation_id}`
  const actionId = metadataString(activity.metadata, ['action_id'])
  if (actionId) return `action:${actionId}`
  return undefined
}

function actionForOperationKind(kind: Operation['kind']): ActivityAction {
  const actions: Record<Operation['kind'], ActivityAction> = {
    shield: 'Shield',
    place_order: 'Place Order',
    unshield: 'Unshield',
    cancel_order: 'Cancel Order',
  }
  return actions[kind]
}

function actionForValue(value?: string): ActivityAction | undefined {
  if (!value) return undefined
  return ({
    create_desk: 'Deploy',
    create_contract: 'Deploy',
    deploy: 'Deploy',
    update_wasm: 'Deploy',
    upload_wasm: 'Deploy',
    shield: 'Shield',
    shield_from_base: 'Shield',
    unshield: 'Unshield',
    submit_order: 'Place Order',
    place_order: 'Place Order',
    cancel_order: 'Cancel Order',
  } as Partial<Record<string, ActivityAction>>)[value]
}

function activityType(activity: ActivityEvent) {
  if (activity.kind === 'backend_operation') return title(metadataString(activity.metadata, ['event_type']) ?? 'operation')
  if (activity.kind === 'note_indexed') return 'Note indexed'
  if (activity.kind === 'transaction') return activity.method ? `${title(activity.method)} transaction` : 'Transaction'
  if (activity.action) return title(activity.action)
  if (activity.method) return title(activity.method)
  if (activity.kind === 'contract_event') return title(String(activity.status ?? 'contract event'))
  return title(activity.kind)
}

function txLabel(activity: ActivityEvent) {
  if (activity.method) return title(activity.method)
  if (activity.action) return title(activity.action)
  return activity.kind === 'backend_operation' ? title(metadataString(activity.metadata, ['event_type']) ?? 'transaction') : activityType(activity)
}

function txStatus(activity: ActivityEvent) {
  return displayStatus(activity.status)
}

function latestStatus(activities: ActivityEvent[]) {
  return activities.map((activity) => activity.status).find((status) => status !== undefined)
}

function statusRank(status?: string) {
  return ({ prepared: 1, submitted: 2, running: 3, succeeded: 4, failed: 4, cancelled: 4 } as Record<string, number>)[status ?? ''] ?? 0
}

function summaryForOperation(operation: Operation, activities: ActivityEvent[]) {
  const request = operation.request
  const fromActivity = summaryForActivities(actionForOperationKind(operation.kind), activities)
  switch (request.kind) {
    case 'shield':
      return `Asset #${request.asset_id}, ${request.amount}`
    case 'unshield':
      return `Asset #${request.asset_id}, ${request.amount} to ${request.recipient}`
    case 'place_order':
      return orderSummary({ activities }) ?? `Pair #${request.pair_id}, ${request.side}, in ${request.amount_in}, min out ${request.min_out}${request.partial_allowed ? ', partial' : ''}`
    case 'cancel_order': {
      const note = metadataString({ request, activities }, ['cancelled_note_id', 'wallet_note_id']) ?? request.wallet_note_id
      const pair = metadataNumber({ activities }, ['pair_id'])
      const side = sideName(metadataString({ activities }, ['side']) ?? metadataNumber({ activities }, ['side']))
      const refund = refundSummary(activities)
      const details = [`Order ${short(note)}`, pair === undefined ? undefined : `pair #${pair}`, side, refund].filter(Boolean)
      return details.length ? details.join(', ') : fromActivity
    }
  }
}

function summaryForActivities(action: ActivityAction, activities: ActivityEvent[]) {
  const metadata = { activities }
  switch (action) {
    case 'Deploy': {
      const name = metadataString(metadata, ['name'])
      const assetCount = metadataNumber(metadata, ['asset_count'])
      const pairCount = metadataNumber(metadata, ['pair_count'])
      return [name, assetCount === undefined ? undefined : `${assetCount} assets`, pairCount === undefined ? undefined : `${pairCount} pairs`]
        .filter(Boolean)
        .join(', ') || 'Desk deployment'
    }
    case 'Shield':
      return amountAssetSummary(metadata) ?? 'Shield funds'
    case 'Unshield': {
      const recipient = metadataString(metadata, ['recipient'])
      return [amountAssetSummary(metadata), recipient ? `to ${recipient}` : undefined].filter(Boolean).join(', ') || 'Unshield funds'
    }
    case 'Place Order': {
      const formatted = orderSummary(metadata)
      if (formatted) return formatted
      const partial = metadataBoolean(metadata, ['partial_allowed'])
      return [
        fallbackOrderSummary(metadata),
        partial ? 'partial' : undefined,
      ].filter(Boolean).join(', ') || 'Order proof submitted'
    }
    case 'Cancel Order': {
      const note = metadataString(metadata, ['cancelled_note_id', 'wallet_note_id'])
      const pair = metadataNumber(metadata, ['pair_id'])
      const side = sideName(metadataString(metadata, ['side']) ?? metadataNumber(metadata, ['side']))
      const refund = refundSummary(activities)
      return [
        note ? `Order ${short(note)}` : 'Order',
        pair === undefined ? undefined : `pair #${pair}`,
        side,
        refund,
      ].filter(Boolean).join(', ')
    }
  }
}

function amountAssetSummary(value: unknown) {
  const amount = metadataString(value, ['amount'])
  const symbol = metadataString(value, ['symbol'])
  const assetId = metadataNumber(value, ['asset_id'])
  if (!amount) return undefined
  return `${amount} ${symbol ?? (assetId === undefined ? 'units' : `asset #${assetId}`)}`
}

function refundSummary(activities: ActivityEvent[]) {
  const metadata = { activities }
  const amount = metadataString(metadata, ['refund_amount', 'amount_in'])
  const symbol = metadataString(metadata, ['refund_symbol', 'symbol_in'])
  const asset = metadataNumber(metadata, ['refund_asset_id', 'asset_in'])
  if (!amount) return undefined
  return `refund ${amount} ${symbol ?? (asset === undefined ? 'units' : `asset #${asset}`)}`
}

function orderSummary(value: unknown) {
  const side = sideName(metadataString(value, ['side']) ?? metadataNumber(value, ['side']))
  const baseSymbol = metadataString(value, ['base_symbol'])
  const quoteSymbol = metadataString(value, ['quote_symbol'])
  const amountIn = metadataString(value, ['amount_in'])
  const minOut = metadataString(value, ['min_out'])
  const baseDecimals = metadataNumber(value, ['base_decimals'])
  const quoteDecimals = metadataNumber(value, ['quote_decimals'])
  if (!side || !baseSymbol || !quoteSymbol || !amountIn || !minOut || baseDecimals === undefined || quoteDecimals === undefined) return undefined
  const baseRaw = BigInt(side === 'SELL' ? amountIn : minOut)
  const quoteRaw = BigInt(side === 'SELL' ? minOut : amountIn)
  const size = formatAmount(baseRaw, baseDecimals)
  const price = formatPrice(baseRaw, quoteRaw, baseDecimals, quoteDecimals)
  if (!price) return undefined
  return `${baseSymbol}/${quoteSymbol} ${side} ${size}@${price}`
}

function fallbackOrderSummary(value: unknown) {
  const pair = metadataNumber(value, ['pair_id'])
  const side = sideName(metadataString(value, ['side']) ?? metadataNumber(value, ['side']))
  const amountIn = metadataString(value, ['amount_in'])
  const minOut = metadataString(value, ['min_out'])
  return [
    pair === undefined ? undefined : `Pair #${pair}`,
    side,
    amountIn ? `in ${amountIn}` : undefined,
    minOut ? `min out ${minOut}` : undefined,
  ].filter(Boolean).join(', ')
}

function sideName(value: unknown) {
  if (value === 'BUY' || value === 'SELL') return value
  if (value === 0 || value === '0') return 'BUY'
  if (value === 1 || value === '1') return 'SELL'
  return undefined
}

function title(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

export function formatStatus(status?: string) {
  return status ? status.replaceAll('_', ' ') : 'event'
}

export function statusTone(status?: string) {
  if (status === 'succeeded') return 'ok'
  if (status === 'failed' || status === 'cancelled') return 'err'
  if (displayStatus(status) === 'running') return 'busy'
  return 'idle'
}

export function short(value: string) {
  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value
}

function metadataString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = metadataString(item, keys)
      if (found) return found
    }
    return undefined
  }
  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key) && (typeof child === 'string' || typeof child === 'number' || typeof child === 'bigint')) return String(child)
    const found = metadataString(child, keys)
    if (found) return found
  }
  return undefined
}

function metadataNumber(value: unknown, keys: string[]): number | undefined {
  const found = metadataString(value, keys)
  if (found === undefined) return undefined
  const n = Number(found)
  return Number.isFinite(n) ? n : undefined
}

function metadataBoolean(value: unknown, keys: string[]): boolean | undefined {
  const found = metadataString(value, keys)
  if (found === undefined) return undefined
  if (found === 'true' || found === '1') return true
  if (found === 'false' || found === '0') return false
  return undefined
}

function transactionHashes(activity: ActivityEvent) {
  const out = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value !== 'string') return
    const matches = value.match(/0x[0-9a-f]{64}|(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi) ?? []
    for (const match of matches) out.add(match)
  }
  const visit = (value: unknown, key = '') => {
    if (typeof value === 'string') {
      if (['tx_hash', 'txHash', 'transaction', 'base_tx_hash', 'baseTxHash', 'result'].includes(key)) add(value)
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

export function txUrl(tx: string, activity: ActivityEvent) {
  if (/^0x[0-9a-f]{64}$/i.test(tx)) return `https://sepolia.basescan.org/tx/${tx}`
  return `https://stellar.expert/explorer/${stellarExpertNetwork(activity)}/tx/${tx.replace(/^0x/i, '')}`
}

export function stellarAddressUrl(address: string) {
  const path = address.startsWith('C') ? 'contract' : 'account'
  return `https://stellar.expert/explorer/testnet/${path}/${address}`
}

function stellarExpertNetwork(activity: ActivityEvent) {
  const network = String(activity.network ?? '').toLowerCase()
  if (network.includes('public') || network.includes('mainnet')) return 'public'
  if (network.includes('futurenet')) return 'futurenet'
  return 'testnet'
}
