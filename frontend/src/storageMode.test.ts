import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultCatalogAssets, mergeCatalogAssets } from './defaultCatalog.ts'
import { indexedDbName } from './sdk/indexedDbStore.ts'
import type { CatalogAsset } from './api.ts'

test('mode-scoped IndexedDB names are separate', () => {
  assert.equal(indexedDbName('trusted'), 'mosaic-trusted')
  assert.equal(indexedDbName('trustless'), 'mosaic-trustless')
  assert.notEqual(indexedDbName('trusted'), indexedDbName('trustless'))
})

test('local catalog is seeded with default assets', () => {
  const merged = mergeCatalogAssets([])
  assert.deepEqual(merged.map((asset) => asset.id), ['default-eth', 'default-usdc', 'default-xlm'])
  assert.equal(merged.every((asset) => asset.trusted_by_me), true)
})

test('local catalog overrides defaults without affecting other ids', () => {
  const override: CatalogAsset = {
    ...defaultCatalogAssets()[0],
    trusted_by_me: false,
  }
  const custom: CatalogAsset = {
    id: 'local-btc',
    symbol: 'BTC',
    stellar_token: 'represented',
    stellar_decimals: 8,
    base_chain_id: 84_532,
    base_token: 'native',
    base_decimals: 8,
    proposer_address: null,
    is_default: false,
    created_at: 1,
    trust_count: 0,
    trusted_by_me: true,
  }
  const merged = mergeCatalogAssets([override, custom])
  assert.equal(merged.find((asset) => asset.id === 'default-usdc')?.trusted_by_me, false)
  assert.equal(merged.find((asset) => asset.id === 'default-xlm')?.trusted_by_me, true)
  assert.equal(merged.find((asset) => asset.id === 'local-btc')?.trusted_by_me, true)
})
