import assert from 'node:assert/strict'
import test from 'node:test'
import { Networks } from '@stellar/stellar-sdk'
import { encodeDeskShare, parseDeskShare } from './deskShare.ts'
import type { Desk } from './api.ts'

const desk: Desk = {
  id: 'desk-1',
  name: 'Shared desk',
  contract_id: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  sponsor_pubkey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  event_start_ledger: 123,
  assets: [
    { asset_id: 1, symbol: 'XLM', token: 'native', decimals: 7, kind: 'Stellar' },
    { asset_id: 2, symbol: 'USDC', token: 'CB'.padEnd(56, 'A'), decimals: 7, kind: 'Dual' },
    { asset_id: 3, symbol: 'ETH', token: null, decimals: 18, kind: 'BaseRepresented' },
  ],
  pairs: [
    { pair_id: 0, base_asset: 1, quote_asset: 2 },
    { pair_id: 1, base_asset: 3, quote_asset: 2 },
  ],
  base_deployment: null,
}

test('desk share round-trips a representative desk', async () => {
  const share = await encodeDeskShare(desk, Networks.TESTNET)
  const parsed = await parseDeskShare(share)
  assert.equal(parsed.networkPassphrase, Networks.TESTNET)
  assert.deepEqual(parsed.desk, desk)
})

test('desk share accepts line wrapping and header footer block', async () => {
  const share = await encodeDeskShare(desk, Networks.TESTNET)
  const compact = share.split('\n').slice(1, -1).join('')
  const wrapped = `-----BEGIN MOSAIC DESK-----\n${compact.slice(0, 20)}\n${compact.slice(20, 85)}\n${compact.slice(85)}\n-----END MOSAIC DESK-----`
  const parsed = await parseDeskShare(wrapped)
  assert.deepEqual(parsed.desk, desk)
})

test('desk share rejects an unsupported prefix', async () => {
  const share = await encodeDeskShare(desk, Networks.TESTNET)
  await assert.rejects(parseDeskShare(share.replace('MOSAIC-DESK-V1', 'MOSAIC-DESK-V0')), /unsupported format/i)
})

test('desk share rejects checksum mismatch', async () => {
  const share = await encodeDeskShare(desk, Networks.TESTNET)
  const parts = share.split('\n').slice(1, -1).join('').split('.')
  parts[1] = `${parts[1][0] === 'A' ? 'B' : 'A'}${parts[1].slice(1)}`
  const tampered = `-----BEGIN MOSAIC DESK-----\n${parts.join('.')}\n-----END MOSAIC DESK-----`
  await assert.rejects(parseDeskShare(tampered), /checksum/i)
})

test('desk share rejects malformed payloads and missing required fields', async () => {
  await assert.rejects(parseDeskShare('MOSAIC-DESK-V1.not-base64.000000000000'), /checksum|base64url/i)

  const share = await encodeDeskShare({ ...desk, name: '' }, Networks.TESTNET)
  await assert.rejects(parseDeskShare(share), /desk name/i)
})
