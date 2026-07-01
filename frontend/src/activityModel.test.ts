import assert from 'node:assert/strict'
import test from 'node:test'
import type { ActivityEvent } from '@mosaic/sdk'
import type { Operation } from './api.ts'
import { activityGroups } from './components/activityModel.ts'

test('shield action and transaction activity collapse into one formatted group', () => {
  const actionId = 'action-shield-1'
  const activities: ActivityEvent[] = [
    {
      kind: 'transaction',
      method: 'shield',
      status: 'succeeded',
      tx_hash: 'a'.repeat(64),
      metadata: { action_id: actionId },
      created_at: 2,
    },
    {
      kind: 'user_action',
      action: 'shield',
      status: 'staged',
      metadata: {
        action_id: actionId,
        asset_id: 1,
        symbol: 'XLM',
        decimals: 7,
        amount: '100000000',
      },
      created_at: 1,
    },
  ]

  const groups = activityGroups(activities, [])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].action, 'Shield')
  assert.equal(groups[0].summary, '10 XLM')
  assert.equal(groups[0].lines.length, 1)
})

test('legacy shield transaction without action id merges into matching action group', () => {
  const actionId = 'action-shield-legacy'
  const deskId = 'desk-1'
  const activities: ActivityEvent[] = [
    {
      kind: 'transaction',
      method: 'shield',
      status: 'succeeded',
      desk_id: deskId,
      tx_hash: 'b'.repeat(64),
      created_at: 2,
    },
    {
      kind: 'user_action',
      action: 'shield',
      status: 'succeeded',
      desk_id: deskId,
      metadata: {
        action_id: actionId,
        asset_id: 1,
        symbol: 'XLM',
        decimals: 7,
        amount: '100000000',
      },
      created_at: 1,
    },
  ]

  const groups = activityGroups(activities, [])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].action, 'Shield')
  assert.equal(groups[0].summary, '10 XLM')
  assert.equal(groups[0].lines.length, 1)
})

test('submit order transaction and place order action collapse into one place order group', () => {
  const actionId = 'action-order-1'
  const tx = 'c'.repeat(64)
  const activities: ActivityEvent[] = [
    {
      kind: 'transaction',
      method: 'submit_order',
      status: 'succeeded',
      tx_hash: tx,
      metadata: { action_id: actionId },
      created_at: 3,
    },
    {
      kind: 'user_action',
      action: 'place_order',
      status: 'staged',
      metadata: {
        action_id: actionId,
        pair_id: 0,
        side: 'SELL',
        base_symbol: 'XLM',
        quote_symbol: 'USDC',
        base_decimals: 7,
        quote_decimals: 7,
        amount_in: '250000000',
        min_out: '50000000',
        partial_allowed: false,
      },
      created_at: 2,
    },
  ]

  const groups = activityGroups(activities, [])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].action, 'Place Order')
  assert.equal(groups[0].summary, 'XLM/USDC SELL 25@0.2')
  assert.deepEqual(groups[0].lines.map((line) => line.label), ['Place Order'])
})

test('sponsored transaction metadata action id collapses with local wallet action', () => {
  const actionId = 'action-sponsored-unshield'
  const tx = 'd'.repeat(64)
  const activities: ActivityEvent[] = [
    {
      kind: 'transaction',
      method: 'unshield',
      status: 'succeeded',
      tx_hash: tx,
      metadata: { action_id: actionId, sponsored: true, result_status: 'SUCCESS' },
      created_at: 2,
    },
    {
      kind: 'user_action',
      action: 'unshield',
      status: 'staged',
      metadata: {
        action_id: actionId,
        recipient: 'G'.padEnd(56, 'A'),
        asset_id: 1,
        symbol: 'XLM',
        decimals: 7,
        amount: '30000000',
      },
      created_at: 1,
    },
  ]

  const groups = activityGroups(activities, [])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].action, 'Unshield')
  assert.equal(groups[0].summary, `3 XLM, to ${'G'.padEnd(56, 'A')}`)
  assert.equal(groups[0].lines.length, 1)
})

test('trusted backend operation events with operation id collapse into one operation group', () => {
  const operationId = 'operation-shield-1'
  const operation: Operation = {
    id: operationId,
    address: 'G'.padEnd(56, 'B'),
    network: 'testnet',
    desk_id: 'desk-2',
    kind: 'shield',
    request: { kind: 'shield', desk_id: 'desk-2', asset_id: 1, amount: '100000000' },
    status: 'succeeded',
    created_at: 1,
    updated_at: 4,
    submitted: true,
  }
  const activities: ActivityEvent[] = [
    {
      kind: 'backend_operation',
      operation_id: operationId,
      status: 'waiting_for_chain',
      message: 'Transaction submitted',
      metadata: { event_type: 'submitted' },
      created_at: 2,
    },
    {
      kind: 'backend_operation',
      operation_id: operationId,
      status: 'succeeded',
      message: 'On-chain transaction confirmed',
      metadata: { event_type: 'confirmed', details: { result: 'e'.repeat(64) } },
      created_at: 3,
    },
  ]

  const groups = activityGroups(activities, [operation])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].id, `operation:${operationId}`)
  assert.equal(groups[0].action, 'Shield')
  assert.equal(groups[0].status, 'succeeded')
  assert.equal(groups[0].summary, 'Asset #1, 100000000')
  assert.equal(groups[0].lines.length, 1)
})
