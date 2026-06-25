import assert from 'node:assert/strict'
import test from 'node:test'
import { eligibleBaseAssets, hasEnoughEth, readPendingDeployment } from './baseDeployment.ts'
import type { CatalogAsset } from './api.ts'

const asset = (overrides: Partial<CatalogAsset>): CatalogAsset => ({
  id: 'id',
  symbol: 'USDC',
  stellar_token: 'native',
  stellar_decimals: 7,
  base_chain_id: 84_532,
  base_token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  base_decimals: 6,
  proposer_address: null,
  is_default: true,
  created_at: 0,
  trust_count: 0,
  trusted_by_me: true,
  ...overrides,
})

test('only Base Sepolia ERC-20 assets are deployment eligible', () => {
  const eligible = eligibleBaseAssets([
    asset({ id: 'usdc' }),
    asset({ id: 'eth', base_token: 'native' }),
    asset({ id: 'mainnet', base_chain_id: 8453 }),
  ])
  assert.deepEqual(eligible.map((value) => value.id), ['usdc'])
})

test('deployment requires a known balance covering the buffered estimate', () => {
  assert.equal(hasEnoughEth(100n, 99n), true)
  assert.equal(hasEnoughEth(98n, 99n), false)
  assert.equal(hasEnoughEth(null, 99n), false)
})

test('pending deployment recovery rejects malformed storage', () => {
  const valid = { getItem: () => JSON.stringify({ tx_hash: '0x01', bridge_address: '0x02' }) }
  const invalid = { getItem: () => '{bad json' }
  assert.deepEqual(readPendingDeployment(valid, 'desk'), { tx_hash: '0x01', bridge_address: '0x02' })
  assert.equal(readPendingDeployment(invalid, 'desk'), null)
})
