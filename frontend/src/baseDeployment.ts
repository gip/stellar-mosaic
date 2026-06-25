import type { AssetKind, CatalogAsset } from './api'

export interface PendingBaseDeployment {
  tx_hash: string
  bridge_address: string
}

/** MosaicBridge sentinel for an asset whose Base side is native ETH (must match `NATIVE` in
 * evm/src/MosaicBridge.sol and the backend `NATIVE_EVM_SENTINEL`). */
export const NATIVE_EVM_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

/** Assets with a Base Sepolia side — an ERC-20 (0x address) or native ETH ("native"). */
export function eligibleBaseAssets(assets: CatalogAsset[]): CatalogAsset[] {
  return assets.filter(
    (asset) =>
      asset.base_chain_id === 84_532
      && typeof asset.base_token === 'string'
      && (asset.base_token === 'native' || /^0x[0-9a-fA-F]{40}$/.test(asset.base_token)),
  )
}

/** The EVM address to register for a Base asset on the MosaicBridge: the ERC-20 address, or the
 * native sentinel for ETH. */
export function baseTokenAddress(asset: CatalogAsset): string {
  return asset.base_token === 'native' ? NATIVE_EVM_SENTINEL : (asset.base_token ?? '')
}

/** Derive the on-chain asset class from a catalog entry. A "represented" Stellar side means the
 * asset has no real Stellar token (Base-distributed, trade-only note). */
export function assetKindOf(asset: CatalogAsset): AssetKind {
  const onBase = !!asset.base_token
  if (asset.stellar_token === 'represented') return 'BaseRepresented'
  return onBase ? 'Dual' : 'Stellar'
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
