import assert from 'node:assert/strict'
import test from 'node:test'
import type { ActivityEvent } from '@mosaic/sdk'
import type { Operation } from './api.ts'
import { activityGroups, txNetworkLabel, txUrl } from './components/activityModel.ts'

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

test('base bridge deployment surfaces the Base Sepolia tx as a BaseScan-linked line', () => {
  const actionId = 'action-deploy-base-1'
  const deskId = 'desk-base-1'
  const contractId = 'C'.padEnd(56, 'D')
  const stellarWasmTx = 'a'.repeat(64)
  const stellarContractTx = 'b'.repeat(64)
  const baseTx = `0x${'f'.repeat(64)}`
  const configureTx = 'c'.repeat(64)
  const activities: ActivityEvent[] = [
    {
      kind: 'user_action',
      action: 'create_desk',
      status: 'started',
      metadata: { action_id: actionId, name: 'Base Desk', asset_count: 1, pair_count: 1 },
      created_at: 1,
    },
    {
      kind: 'user_action',
      action: 'update_wasm',
      status: 'succeeded',
      tx_hash: stellarWasmTx,
      metadata: { action_id: actionId, step: 1 },
      created_at: 2,
    },
    {
      kind: 'user_action',
      action: 'create_contract',
      status: 'succeeded',
      contract_id: contractId,
      tx_hash: stellarContractTx,
      metadata: { action_id: actionId, step: 2, contract_id: contractId },
      created_at: 3,
    },
    {
      kind: 'user_action',
      action: 'deploy_base_bridge',
      status: 'succeeded',
      desk_id: deskId,
      contract_id: contractId,
      tx_hash: baseTx,
      metadata: { action_id: actionId, bridge_address: `0x${'a'.repeat(40)}`, deployer: `0x${'b'.repeat(40)}` },
      created_at: 4,
    },
    {
      kind: 'user_action',
      action: 'configure_base_bridge',
      status: 'succeeded',
      desk_id: deskId,
      contract_id: contractId,
      tx_hash: configureTx,
      metadata: { action_id: actionId, bridge_address: `0x${'a'.repeat(40)}` },
      created_at: 5,
    },
    {
      kind: 'user_action',
      action: 'create_desk',
      status: 'succeeded',
      desk_id: deskId,
      contract_id: contractId,
      metadata: { action_id: actionId, name: 'Base Desk' },
      created_at: 6,
    },
  ]

  const groups = activityGroups(activities, [])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].action, 'Deploy')
  const txs = groups[0].lines.map((line) => line.tx)
  assert.ok(txs.includes(baseTx), 'the Base Sepolia tx should appear as a line')
  assert.ok(txs.includes(stellarWasmTx) && txs.includes(stellarContractTx) && txs.includes(configureTx))
  const baseLine = groups[0].lines.find((line) => line.tx === baseTx)
  assert.ok(baseLine?.activity)
  assert.equal(txUrl(baseLine.tx as string, baseLine.activity), `https://sepolia.basescan.org/tx/${baseTx}`)
  const describe = (tx: string) => groups[0].lines.find((line) => line.tx === tx)?.description
  assert.equal(describe(stellarWasmTx), 'Upload code')
  assert.equal(describe(stellarContractTx), 'Deploy contract')
  assert.equal(describe(baseTx), 'Deploy Base bridge')
  assert.equal(describe(configureTx), 'Configure bridge')
  assert.equal(txNetworkLabel(baseTx, baseLine.activity!), 'Base Sepolia')
  const stellarLine = groups[0].lines.find((line) => line.tx === stellarWasmTx)!
  assert.equal(txNetworkLabel(stellarLine.tx!, stellarLine.activity!), 'Stellar Testnet')
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
  assert.equal(groups[0].lines[0].description, 'Confirm on chain')
})
