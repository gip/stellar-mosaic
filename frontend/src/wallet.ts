// Freighter wallet wrapper (freighter-api v6). Used for login and (Phase 2+) signing the shield
// auth entry. Relayer-submittable actions (order/unshield/cancel) need no wallet signature.
import {
  isConnected,
  requestAccess,
  getAddress,
  getNetwork,
  getNetworkDetails,
  signMessage,
} from '@stellar/freighter-api'
import { Networks } from '@stellar/stellar-sdk'

function normalizeNetworkPassphrase(network: string | undefined, networkPassphrase: string | undefined): string {
  if (networkPassphrase) return networkPassphrase

  const normalized = (network ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (normalized === 'testnet' || normalized === 'test') return Networks.TESTNET
  if (normalized === 'public' || normalized === 'pubnet' || normalized === 'mainnet' || normalized === 'main') {
    return Networks.PUBLIC
  }
  return ''
}

function normalizedNetworkResult(network: string | undefined, networkPassphrase: string | undefined) {
  const normalizedPassphrase = normalizeNetworkPassphrase(network, networkPassphrase)
  if (!normalizedPassphrase) return null
  return { network: network ?? '', networkPassphrase: normalizedPassphrase }
}

export async function walletInstalled(): Promise<boolean> {
  try {
    const r = await isConnected()
    return !!r.isConnected
  } catch {
    return false
  }
}

/** Prompt the user to connect; returns the selected G... address. */
export async function connect(): Promise<string> {
  const r = await requestAccess()
  if (r.error) throw new Error(r.error)
  if (!r.address) throw new Error('No address returned by Freighter')
  return r.address
}

/** Returns the already-authorized address, or null if not connected/allowed. */
export async function currentAddress(): Promise<string | null> {
  try {
    const r = await getAddress()
    if (r.error || !r.address) return null
    return r.address
  } catch {
    return null
  }
}

export async function network(): Promise<{ network: string; networkPassphrase: string } | null> {
  try {
    const details = await getNetworkDetails()
    if (!details.error) {
      const result = normalizedNetworkResult(details.network, details.networkPassphrase)
      if (result) return result
    }

    const fallback = await getNetwork()
    if (fallback.error) return null
    return normalizedNetworkResult(fallback.network, fallback.networkPassphrase)
  } catch {
    return null
  }
}

export async function signRecoveryMessage(
  message: string,
  address: string,
  networkPassphrase: string,
) {
  const r = await signMessage(message, { address, networkPassphrase })
  if (r.error) throw new Error(String(r.error))
  return r
}
