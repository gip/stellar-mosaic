import type { CatalogAsset } from './api'

export function defaultCatalogAssets(): CatalogAsset[] {
  const created_at = 0
  return [
    {
      id: 'default-usdc',
      symbol: 'USDC',
      stellar_token: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      stellar_decimals: 7,
      base_chain_id: 84532,
      base_token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      base_decimals: 6,
      proposer_address: null,
      is_default: true,
      created_at,
      trust_count: 0,
      trusted_by_me: true,
    },
    {
      id: 'default-xlm',
      symbol: 'XLM',
      stellar_token: 'native',
      stellar_decimals: 7,
      base_chain_id: null,
      base_token: null,
      base_decimals: null,
      proposer_address: null,
      is_default: true,
      created_at,
      trust_count: 0,
      trusted_by_me: true,
    },
    {
      id: 'default-eth',
      symbol: 'ETH',
      stellar_token: 'represented',
      stellar_decimals: 18,
      base_chain_id: 84532,
      base_token: 'native',
      base_decimals: 18,
      proposer_address: null,
      is_default: true,
      created_at,
      trust_count: 0,
      trusted_by_me: true,
    },
  ]
}

export function mergeCatalogAssets(local: CatalogAsset[]): CatalogAsset[] {
  const byId = new Map<string, CatalogAsset>()
  for (const asset of defaultCatalogAssets()) byId.set(asset.id, asset)
  for (const asset of local) byId.set(asset.id, asset)
  return [...byId.values()].sort((a, b) =>
    Number(b.is_default) - Number(a.is_default) || a.created_at - b.created_at || a.symbol.localeCompare(b.symbol),
  )
}
