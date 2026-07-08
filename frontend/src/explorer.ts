/** Stellar Expert explorer link for a settlement transaction (testnet, matching the app network). */
export function stellarExpertTxUrl(txHash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${txHash.replace(/^0x/i, '')}`
}

/** Stellar Expert explorer link for a contract (testnet, matching the app network). */
export function stellarExpertContractUrl(contractId: string): string {
  return `https://stellar.expert/explorer/testnet/contract/${contractId}`
}

/** Basescan explorer link for an address (Base Sepolia, matching the app network). */
export function basescanAddressUrl(address: string): string {
  return `https://sepolia.basescan.org/address/${address}`
}
