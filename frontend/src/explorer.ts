/** Stellar Expert explorer link for a settlement transaction (testnet, matching the app network). */
export function stellarExpertTxUrl(txHash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${txHash.replace(/^0x/i, '')}`
}
