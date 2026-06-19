// Freighter wallet wrapper (freighter-api v6). Used for login and (Phase 2+) signing the shield
// auth entry. Relayer-submittable actions (order/unshield/cancel) need no wallet signature.
import {
  isConnected,
  requestAccess,
  getAddress,
  getNetwork,
} from '@stellar/freighter-api'

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

export async function network(): Promise<string | null> {
  try {
    const r = await getNetwork()
    return r.network ?? null
  } catch {
    return null
  }
}
