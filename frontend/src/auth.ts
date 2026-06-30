import { api } from './api'
import { FreighterSigner } from './sdk/freighterSigner'

let inFlight: Promise<void> | null = null

/** Establish an MCP session with a login-specific wallet signature. */
export async function ensureBackendSession(
  address: string,
  networkPassphrase: string,
): Promise<void> {
  void networkPassphrase
  if (inFlight) return inFlight
  inFlight = (async () => {
    const current = await api.getAuthSession().catch(() => null)
    if (current?.address === address) return
    await api.deleteAuthSession().catch(() => {})
    await api.mcp().authenticate(new FreighterSigner(address))
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}
