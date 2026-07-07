// Master-side agent console logic: one Freighter signature derives the whole agent tree
// (masterRoot lives in memory only, like the recovery module), a second signs the backend auth
// challenge. Everything else — registry, runner credentials, sealing, config, logs — goes through
// the browser-safe @mosaic/agent-sdk/derive surface against the agent backend.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Buffer } from 'buffer'
import {
  AgentBackendClient,
  AgentRoot,
  agentMasterMessage,
  deriveAgentRoot,
  deriveRunnerKeys,
  encodeRunnerIdentity,
  generateRunnerSecret,
  sealAgentRoot,
  toHex,
  type AgentConfig,
  type AgentRecord,
  type AgentSessionRecord,
  type BackendInfo,
  type LogEntry,
  type RunnerRecord,
} from '@mosaic/agent-sdk/derive'
import { AGENT_BACKEND_URL } from '../config'
import { signRecoveryMessage } from '../wallet'

// An unlocked session survives navigation (module scope, keyed by wallet address) so returning
// to the console never re-prompts; a reload starts locked by design — the derivation root only
// ever lives in memory.
interface CachedSession {
  address: string
  root: AgentRoot
  client: AgentBackendClient
  info: BackendInfo | null
}
let cachedSession: CachedSession | null = null

function signatureBytes(value: string | Uint8Array | null): Uint8Array {
  if (!value) throw new Error('Freighter returned no signature.')
  if (typeof value !== 'string') return Uint8Array.from(value)
  return Uint8Array.from(Buffer.from(value, 'base64'))
}

async function freighterSign(message: string, address: string, networkPassphrase: string): Promise<Uint8Array> {
  const signed = await signRecoveryMessage(message, address, networkPassphrase)
  if (signed.signerAddress !== address) throw new Error('Freighter signed with a different account.')
  return signatureBytes(signed.signedMessage)
}

export interface AgentConsole {
  unlocked: boolean
  busy: string | null
  error: string | null
  info: BackendInfo | null
  agents: AgentRecord[]
  runners: RunnerRecord[]
  unlock(): Promise<void>
  refresh(): Promise<void>
  clearError(): void
  /** Register the next agent identity; seals it to every active runner. */
  createAgent(name: string): Promise<AgentRecord>
  revokeAgent(agentId: string): Promise<void>
  setDesiredState(agentId: string, state: 'running' | 'stopped'): Promise<void>
  /** Register a runner and seal every agent to it. Returns the one-time MOSAIC_IDENTITY. */
  createRunner(name: string): Promise<string>
  revokeRunner(runnerId: string): Promise<void>
  setRuntimeVersion(runnerId: string, version: string): Promise<void>
  agentConfig(agent: AgentRecord): Promise<AgentConfig | null>
  saveConfig(agentId: string, config: AgentConfig): Promise<void>
  sessions(agentId: string): Promise<AgentSessionRecord[]>
  sessionLogs(sessionId: string): Promise<LogEntry[]>
}

export function useAgentConsole(address: string | null, networkPassphrase: string | null): AgentConsole {
  const cached = cachedSession && address && cachedSession.address === address ? cachedSession : null
  const rootRef = useRef<AgentRoot | null>(cached?.root ?? null)
  const clientRef = useRef<AgentBackendClient | null>(cached?.client ?? null)
  const [unlocked, setUnlocked] = useState(!!cached)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<BackendInfo | null>(cached?.info ?? null)
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [runners, setRunners] = useState<RunnerRecord[]>([])

  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
    setBusy(label)
    setError(null)
    try {
      return await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      setBusy(null)
    }
  }, [])

  const requireSession = useCallback(() => {
    const root = rootRef.current
    const client = clientRef.current
    if (!root || !client) throw new Error('Unlock the agent console first.')
    return { root, client }
  }, [])

  const refresh = useCallback(async () => {
    const { client } = requireSession()
    const [nextAgents, nextRunners] = await Promise.all([client.listAgents(), client.listRunners()])
    setAgents(nextAgents)
    setRunners(nextRunners)
  }, [requireSession])

  // A session restored from the cache still has to fetch the lists; if the backend session
  // expired in the meantime, drop it so the caller unlocks afresh.
  const restoredRef = useRef(!!cached)
  useEffect(() => {
    if (!restoredRef.current) return
    restoredRef.current = false
    refresh().catch(() => {
      cachedSession = null
      rootRef.current = null
      clientRef.current = null
      setUnlocked(false)
    })
  }, [refresh])

  const unlock = useCallback(async () => {
    if (!address || !networkPassphrase) throw new Error('Connect the Stellar wallet first.')
    await run('Unlocking…', async () => {
      const ref = { chain: 'stellar' as const, address, networkPassphrase }
      // Signature 1: the derivation root (deterministic — same keys every unlock).
      const signature = await freighterSign(agentMasterMessage(ref), address, networkPassphrase)
      const root = await deriveAgentRoot(signature, ref)
      // Signature 2: the backend auth challenge (fresh nonce every time).
      const client = new AgentBackendClient(AGENT_BACKEND_URL)
      await client.authenticateMasterStellar({
        address: async () => address,
        signMessage: (message: Uint8Array) =>
          freighterSign(new TextDecoder().decode(message), address, networkPassphrase),
      })
      rootRef.current = root
      clientRef.current = client
      const nextInfo = await client.info()
      cachedSession = { address, root, client, info: nextInfo }
      setInfo(nextInfo)
      const [nextAgents, nextRunners] = await Promise.all([client.listAgents(), client.listRunners()])
      setAgents(nextAgents)
      setRunners(nextRunners)
      setUnlocked(true)
    })
  }, [address, networkPassphrase, run])

  const sealToRunner = useCallback(
    async (agent: AgentRecord, runner: RunnerRecord) => {
      const { root, client } = requireSession()
      const agentRoot = await root.agentRootBytes(agent.index)
      const sealPub = Uint8Array.from(Buffer.from(runner.seal_public_key, 'hex'))
      const envelope = await sealAgentRoot(agentRoot, sealPub, { agentId: agent.id, runnerId: runner.id })
      await client.putSealedRoot(agent.id, runner.id, envelope)
    },
    [requireSession],
  )

  const createAgent = useCallback(
    (name: string) =>
      run('Creating agent…', async () => {
        const { root, client } = requireSession()
        const index = agents.reduce((max, a) => Math.max(max, a.index + 1), 0)
        const identity = await root.deriveIdentity(index)
        const record = await client.registerAgent(identity.descriptor(name || undefined))
        for (const runner of runners.filter((r) => !r.revoked)) await sealToRunner(record, runner)
        await refresh()
        return record
      }),
    [agents, runners, refresh, requireSession, run, sealToRunner],
  )

  const createRunner = useCallback(
    (name: string) =>
      run('Creating runner…', async () => {
        const { client } = requireSession()
        const secret = generateRunnerSecret()
        const keys = await deriveRunnerKeys(secret)
        const record = await client.registerRunner({
          ...(name ? { name } : {}),
          auth_public_key: keys.authPublicKey,
          seal_public_key: toHex(keys.sealPublicKey),
        })
        for (const agent of agents.filter((a) => !a.revoked)) await sealToRunner(agent, record)
        await refresh()
        return encodeRunnerIdentity({ backend: AGENT_BACKEND_URL, id: record.id, secret })
      }),
    [agents, refresh, requireSession, run, sealToRunner],
  )

  const revokeAgent = useCallback(
    (agentId: string) =>
      run('Revoking…', async () => {
        await requireSession().client.revokeAgent(agentId)
        await refresh()
      }),
    [refresh, requireSession, run],
  )

  const setDesiredState = useCallback(
    (agentId: string, state: 'running' | 'stopped') =>
      run(state === 'running' ? 'Starting…' : 'Stopping…', async () => {
        await requireSession().client.setDesiredState(agentId, state)
        await refresh()
      }),
    [refresh, requireSession, run],
  )

  const revokeRunner = useCallback(
    (runnerId: string) =>
      run('Revoking…', async () => {
        await requireSession().client.revokeRunner(runnerId)
        await refresh()
      }),
    [refresh, requireSession, run],
  )

  const setRuntimeVersion = useCallback(
    (runnerId: string, version: string) =>
      run('Saving…', async () => {
        await requireSession().client.updateRunner(runnerId, { runtime_version: version })
        await refresh()
      }),
    [refresh, requireSession, run],
  )

  const agentConfig = useCallback(
    async (agent: AgentRecord): Promise<AgentConfig | null> => {
      const data = await requireSession().client.agentDataOf(agent.id)
      return (data.attached['agent-config']?.value as AgentConfig | undefined) ?? null
    },
    [requireSession],
  )

  const saveConfig = useCallback(
    (agentId: string, config: AgentConfig) =>
      run('Saving config…', async () => {
        await requireSession().client.putAgentConfig(agentId, config)
      }),
    [requireSession, run],
  )

  const sessions = useCallback(
    (agentId: string) => requireSession().client.agentSessions(agentId),
    [requireSession],
  )

  const sessionLogs = useCallback(
    (sessionId: string) => requireSession().client.sessionLogs(sessionId),
    [requireSession],
  )

  return {
    unlocked,
    busy,
    error,
    info,
    agents,
    runners,
    unlock,
    refresh: useCallback(() => run('Refreshing…', refresh), [refresh, run]),
    clearError: useCallback(() => setError(null), []),
    createAgent,
    revokeAgent,
    setDesiredState,
    createRunner,
    revokeRunner,
    setRuntimeVersion,
    agentConfig,
    saveConfig,
    sessions,
    sessionLogs,
  }
}
