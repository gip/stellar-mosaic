import assert from 'node:assert/strict'
import test from 'node:test'
import type { ActivityEvent, BaseShieldJob } from '@mosaic/sdk'
import type { Operation } from './api.ts'
import { activityGroups, txNetworkLabel, txUrl } from './components/activityModel.ts'
import { baseShieldJobEvents } from './components/baseShieldActivity.ts'

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
  assert.equal(groups[0].summary, '10 XLM from Stellar Testnet')
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
  assert.equal(groups[0].summary, '10 XLM from Stellar Testnet')
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

test('trustless: assembly join txs surface as lines under the parent place-order group', () => {
  const actionId = 'action-order-assembled'
  const joinTx1 = '1'.repeat(64)
  const joinTx2 = '2'.repeat(64)
  const orderTx = '3'.repeat(64)
  const activities: ActivityEvent[] = [
    {
      kind: 'user_action',
      action: 'join',
      method: 'join',
      status: 'succeeded',
      tx_hash: joinTx1,
      metadata: { action_id: actionId, kind: 'place_order' },
      created_at: 1,
    },
    {
      kind: 'user_action',
      action: 'join',
      method: 'join',
      status: 'succeeded',
      tx_hash: joinTx2,
      metadata: { action_id: actionId, kind: 'place_order' },
      created_at: 2,
    },
    {
      kind: 'user_action',
      action: 'place_order',
      status: 'succeeded',
      tx_hash: orderTx,
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
      created_at: 3,
    },
  ]

  const groups = activityGroups(activities, [])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].action, 'Place Order')
  const txs = groups[0].lines.map((line) => line.tx)
  assert.ok(txs.includes(joinTx1) && txs.includes(joinTx2) && txs.includes(orderTx), 'every on-chain step is a line')
  assert.equal(groups[0].lines.find((line) => line.tx === joinTx1)?.description, 'Combine notes')
})

test('trusted: an operation join line collapses into its operation group', () => {
  const operationId = 'operation-order-assembled'
  const joinTx = '4'.repeat(64)
  const orderTx = '5'.repeat(64)
  const operation: Operation = {
    id: operationId,
    address: 'G'.padEnd(56, 'B'),
    network: 'testnet',
    desk_id: 'desk-3',
    kind: 'place_order',
    request: { kind: 'place_order', desk_id: 'desk-3', pair_id: 0, side: 'SELL', amount_in: '250000000', min_out: '50000000', partial_allowed: false },
    status: 'succeeded',
    created_at: 1,
    updated_at: 4,
    submitted: true,
  }
  const activities: ActivityEvent[] = [
    {
      kind: 'user_action',
      action: 'join',
      method: 'join',
      status: 'succeeded',
      operation_id: operationId,
      tx_hash: joinTx,
      metadata: {},
      created_at: 2,
    },
    {
      kind: 'backend_operation',
      operation_id: operationId,
      status: 'succeeded',
      message: 'On-chain transaction confirmed',
      metadata: { event_type: 'confirmed', details: { tx_hash: orderTx } },
      created_at: 3,
    },
  ]

  const groups = activityGroups(activities, [operation])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].id, `operation:${operationId}`)
  assert.equal(groups[0].action, 'Place Order')
  const txs = groups[0].lines.map((line) => line.tx)
  assert.ok(txs.includes(joinTx) && txs.includes(orderTx), 'the join and the settle both appear as lines')
  assert.equal(groups[0].lines.find((line) => line.tx === joinTx)?.description, 'Combine notes')
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

  // Trusted-mode backend events carry no asset metadata, so the desk catalog resolves the symbol
  // and decimals (asset id + raw amount come from the operation request).
  const catalog = { asset: (deskId: string | undefined, assetId: number) =>
    deskId === 'desk-2' && assetId === 1 ? { symbol: 'XLM', decimals: 7 } : undefined }
  const groups = activityGroups(activities, [operation], catalog)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].id, `operation:${operationId}`)
  assert.equal(groups[0].action, 'Shield')
  assert.equal(groups[0].status, 'succeeded')
  assert.equal(groups[0].summary, '10 XLM from Stellar Testnet')
  assert.equal(groups[0].lines.length, 1)
  assert.equal(groups[0].lines[0].description, 'Confirm on chain')
})

test('base shield deposit and mint collapse into one group linking both txs', () => {
  const jobId = 'job-base-1'
  const baseTx = `0x${'a'.repeat(64)}`
  const stellarTx = 'f'.repeat(64)
  const activities: ActivityEvent[] = [
    {
      kind: 'transaction',
      method: 'shield_from_base',
      status: 'succeeded',
      desk_id: 'desk-3',
      tx_hash: stellarTx,
      metadata: { action_id: jobId, source: 'base', stellar_tx_hash: stellarTx },
      created_at: 5,
    },
    {
      kind: 'transaction',
      method: 'shield_from_base',
      status: 'running',
      desk_id: 'desk-3',
      tx_hash: baseTx,
      metadata: { action_id: jobId, source: 'base', asset_id: 3, symbol: 'ETH', decimals: 18, amount: '1000000000000000000', base_tx_hash: baseTx },
      created_at: 4,
    },
  ]

  const groups = activityGroups(activities, [])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].action, 'Shield')
  assert.equal(groups[0].summary, '1 ETH from Base Sepolia')
  // The group turns green once the later mint leg succeeds, even though the deposit leg stays `running`.
  assert.equal(groups[0].status, 'succeeded')
  assert.equal(groups[0].lines.length, 2)
  const byTx = new Map(groups[0].lines.map((line) => [line.tx, line]))
  assert.equal(txNetworkLabel(baseTx, byTx.get(baseTx)!.activity!), 'Base Sepolia')
  assert.equal(txNetworkLabel(stellarTx, byTx.get(stellarTx)!.activity!), 'Stellar Testnet')
})

test('base shield mint leg alone renders a complete entry from job deposit metadata', () => {
  // The reconciler logs only the terminal mint leg when this session never saw the deposit event
  // (shield started elsewhere). Carrying the deposit metadata (amount + Base tx) off the persisted
  // job, it still renders "1 ETH from Base Sepolia" with both legs — no bare "Shield funds" ghost.
  const baseTx = `0x${'b'.repeat(64)}`
  const stellarTx = 'e'.repeat(64)
  const activities: ActivityEvent[] = [
    {
      kind: 'transaction',
      method: 'shield_from_base',
      status: 'succeeded',
      desk_id: 'desk-3',
      tx_hash: stellarTx,
      metadata: {
        action_id: 'job-base-2',
        source: 'base',
        asset_id: 3,
        symbol: 'ETH',
        decimals: 18,
        amount: '1000000000000000000',
        stellar_tx_hash: stellarTx,
        base_tx_hash: baseTx,
      },
      created_at: 9,
    },
  ]

  const groups = activityGroups(activities, [])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].summary, '1 ETH from Base Sepolia')
  assert.equal(groups[0].status, 'succeeded')
  assert.deepEqual(new Set(groups[0].lines.map((line) => line.tx)), new Set([stellarTx, baseTx]))
})

function baseShieldJob(overrides: Partial<BaseShieldJob> = {}): BaseShieldJob {
  return {
    id: 'job-live-1',
    desk_id: 'desk-3',
    bridge: `0x${'1'.repeat(40)}`,
    deposit_id: 7,
    status: 'proving',
    deposit: {
      asset_id: 3,
      symbol: 'ETH',
      decimals: 18,
      amount: '1000000000000000000',
      base_tx_hash: `0x${'c'.repeat(64)}`,
    },
    ...overrides,
  }
}

test('in-flight base shield job renders a running entry with the Base deposit tx', () => {
  // No persisted Activity events at all (shield started on another device / write lost): the job
  // alone must produce a visible entry for the whole ~10-15 min prove + finality window.
  const job = baseShieldJob({ status: 'awaiting_finality' })
  const groups = activityGroups(baseShieldJobEvents([job], 'GWALLET'), [])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].action, 'Shield')
  assert.equal(groups[0].summary, '1 ETH from Base Sepolia')
  assert.equal(groups[0].status, 'running')
  assert.deepEqual(groups[0].lines.map((line) => line.tx), [job.deposit!.base_tx_hash])
})

test('completed base shield job renders succeeded with both tx links', () => {
  const stellarTx = 'd'.repeat(64)
  const job = baseShieldJob({ status: 'active', stellar_tx_hash: stellarTx })
  const groups = activityGroups(baseShieldJobEvents([job], 'GWALLET'), [])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].summary, '1 ETH from Base Sepolia')
  assert.equal(groups[0].status, 'succeeded')
  const byTx = new Map(groups[0].lines.map((line) => [line.tx, line]))
  assert.deepEqual(new Set(byTx.keys()), new Set([job.deposit!.base_tx_hash, stellarTx]))
  assert.equal(txNetworkLabel(job.deposit!.base_tx_hash!, byTx.get(job.deposit!.base_tx_hash)!.activity!), 'Base Sepolia')
  assert.equal(txNetworkLabel(stellarTx, byTx.get(stellarTx)!.activity!), 'Stellar Testnet')
  // The mint leg re-asserts the Base deposit tx, so both lines read as succeeded.
  assert.equal(byTx.get(job.deposit!.base_tx_hash)!.status, 'succeeded')
})

test('failed base shield job renders failed with the job error', () => {
  const job = baseShieldJob({ status: 'failed', error: 'proof rejected' })
  const groups = activityGroups(baseShieldJobEvents([job], 'GWALLET'), [])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].status, 'failed')
  assert.equal(groups[0].error, 'proof rejected')
})

test('job events merge with persisted legs into one group without duplicate lines', () => {
  const stellarTx = 'a'.repeat(64)
  const job = baseShieldJob({ status: 'active', stellar_tx_hash: stellarTx })
  const persisted: ActivityEvent[] = [
    // The deposit leg the form wrote at submit time: same idempotency key/action_id/tx as the
    // synthesized one, but with a real timestamp. The persisted `running` must not drag the group
    // back from the job's `succeeded`.
    {
      kind: 'transaction',
      method: 'shield_from_base',
      status: 'running',
      desk_id: job.desk_id,
      tx_hash: job.deposit!.base_tx_hash,
      idempotency_key: `base-shield-deposit:${job.id}`,
      metadata: { action_id: job.id, source: 'base', asset_id: 3, symbol: 'ETH', decimals: 18, amount: '1000000000000000000', base_tx_hash: job.deposit!.base_tx_hash },
      created_at: 10,
    },
  ]
  const groups = activityGroups([...persisted, ...baseShieldJobEvents([job], 'GWALLET')], [])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].status, 'succeeded')
  assert.equal(groups[0].createdAt, 10)
  assert.deepEqual(new Set(groups[0].lines.map((line) => line.tx)), new Set([job.deposit!.base_tx_hash, stellarTx]))
  assert.equal(groups[0].lines.length, 2)
})

test('allowlist adds group by action id with member summary and per-chain tx links', () => {
  const actionId = 'action-allow-1'
  const member = 'G' + 'A'.repeat(55)
  const stellarTx = 'd'.repeat(64)
  const baseTx = '0x' + 'e'.repeat(64)
  const activities: ActivityEvent[] = [
    {
      kind: 'user_action',
      action: 'add_allowed',
      status: 'succeeded',
      desk_id: 'desk-1',
      tx_hash: stellarTx,
      metadata: { action_id: actionId, member },
      created_at: 1,
    },
    {
      kind: 'user_action',
      action: 'add_allowed',
      status: 'succeeded',
      desk_id: 'desk-1',
      tx_hash: baseTx,
      metadata: { action_id: actionId, member: '0x' + '1'.repeat(40), chain: 'base' },
      created_at: 2,
    },
  ]

  const groups = activityGroups(activities, [])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].action, 'Allowlist')
  assert.equal(groups[0].summary, 'Allow 2 members')
  assert.equal(groups[0].status, 'succeeded')
  assert.deepEqual(new Set(groups[0].lines.map((line) => line.tx)), new Set([stellarTx, baseTx]))
  assert.ok(txUrl(baseTx, activities[1]).includes('sepolia.basescan.org'))
  assert.ok(txUrl(stellarTx, activities[0]).includes('stellar.expert'))
})

test('a single allowlist add summarizes the member address', () => {
  const member = 'G' + 'B'.repeat(55)
  const groups = activityGroups(
    [
      {
        kind: 'user_action',
        action: 'add_allowed',
        status: 'succeeded',
        desk_id: 'desk-1',
        tx_hash: 'f'.repeat(64),
        metadata: { action_id: 'action-allow-2', member },
        created_at: 1,
      },
    ],
    [],
  )
  assert.equal(groups.length, 1)
  assert.equal(groups[0].action, 'Allowlist')
  assert.equal(groups[0].summary, `Allow ${member.slice(0, 8)}...${member.slice(-6)}`)
  assert.equal(groups[0].lines.length, 1)
})
