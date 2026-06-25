import type { CatalogAsset } from './api'

export interface PendingBaseDeployment {
  tx_hash: string
  bridge_address: string
}

export function eligibleBaseAssets(assets: CatalogAsset[]): CatalogAsset[] {
  return assets.filter(
    (asset) =>
      asset.base_chain_id === 84_532
      && typeof asset.base_token === 'string'
      && /^0x[0-9a-fA-F]{40}$/.test(asset.base_token),
  )
}

export function hasEnoughEth(balance: bigint | null, estimatedMaximumFee: bigint | null): boolean {
  return balance !== null && estimatedMaximumFee !== null && balance >= estimatedMaximumFee
}

export function pendingDeploymentKey(deskId: string): string {
  return `stellar-mosaic.base-deployment.${deskId}`
}

export function readPendingDeployment(
  storage: Pick<Storage, 'getItem'>,
  deskId: string,
): PendingBaseDeployment | null {
  try {
    const parsed = JSON.parse(storage.getItem(pendingDeploymentKey(deskId)) ?? 'null') as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const value = parsed as Partial<PendingBaseDeployment>
    return typeof value.tx_hash === 'string' && typeof value.bridge_address === 'string'
      ? { tx_hash: value.tx_hash, bridge_address: value.bridge_address }
      : null
  } catch {
    return null
  }
}
