import { Buffer } from 'buffer'
import { ApiError, api } from './api'
import { signRecoveryMessage } from './wallet'

let inFlight: Promise<void> | null = null

/** Establish a backend session with a login-specific signature. The recovery signature and its
 * derived keys are never sent to the backend. */
export async function ensureBackendSession(
  address: string,
  networkPassphrase: string,
): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const current = await api.getAuthSession()
      if (current.address === address) return
      await api.deleteAuthSession().catch(() => {})
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error
    }
    const challenge = await api.createAuthChallenge(address)
    const signed = await signRecoveryMessage(challenge.message, address, networkPassphrase)
    if (signed.signerAddress !== address || !signed.signedMessage) {
      throw new Error('Freighter signed the login challenge with a different account.')
    }
    const signature =
      typeof signed.signedMessage === 'string'
        ? signed.signedMessage
        : Buffer.from(signed.signedMessage).toString('base64')
    await api.createAuthSession(challenge.challenge_id, signature)
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}
