// Agents console: unlock with the wallet, manage runner credentials (the MOSAIC_IDENTITY shown
// once at creation), register/configure agent identities, toggle running/stopped, and read
// session logs. All key derivation happens client-side; the backend never sees a private key.

import { useCallback, useState } from 'react'
import type { AgentConfig, AgentRecord } from '@mosaic/agent-sdk/derive'
import { useWallet } from '../WalletContext'
import { useAgentConsole } from '../agents/console'
import ConfigEditor from '../agents/ConfigEditor'
import LogsPanel from '../agents/LogsPanel'
import Button from '../components/ui/Button'
import Field from '../components/ui/Field'
import Modal from '../components/ui/Modal'
import Pane from '../components/ui/Pane'
import StatusDot from '../components/ui/StatusDot'

function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

export default function AgentsPage() {
  const { address, networkPassphrase } = useWallet()
  const console_ = useAgentConsole(address, networkPassphrase)
  const [agentName, setAgentName] = useState('')
  const [runnerName, setRunnerName] = useState('')
  const [revealedIdentity, setRevealedIdentity] = useState<string | null>(null)
  const [identityCopied, setIdentityCopied] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedTab, setSelectedTab] = useState<'config' | 'logs'>('config')
  const [selectedConfig, setSelectedConfig] = useState<AgentConfig | null>(null)
  const [configLoaded, setConfigLoaded] = useState(false)

  const selected: AgentRecord | null = console_.agents.find((a) => a.id === selectedId) ?? null

  const selectAgent = useCallback(
    (agent: AgentRecord) => {
      setSelectedId(agent.id)
      setSelectedConfig(null)
      setConfigLoaded(false)
      console_
        .agentConfig(agent)
        .then((config) => {
          setSelectedConfig(config)
          setConfigLoaded(true)
        })
        .catch(() => setConfigLoaded(true))
    },
    [console_],
  )

  if (!address) {
    return (
      <div className="reading">
        <h2>Agents</h2>
        <p className="muted">Connect your Stellar wallet to manage agents.</p>
      </div>
    )
  }

  if (!console_.unlocked) {
    return (
      <div className="reading">
        <h2>Agents</h2>
        <p className="muted">
          Agent identities are derived deterministically from your wallet: one signature unlocks the whole tree (nothing
          is stored server-side), a second signs the backend login challenge. Re-signing later re-derives the exact same
          agents.
        </p>
        {console_.error && <p className="error-text">{console_.error}</p>}
        <Button variant="primary" disabled={!!console_.busy} onClick={() => void console_.unlock().catch(() => {})}>
          {console_.busy ?? 'Unlock agent console'}
        </Button>
      </div>
    )
  }

  const launchCommand = (identity: string) =>
    `OPENAI_API_KEY=sk-… MOSAIC_IDENTITY=${identity} npx @mosaic/agent-sdk start`

  return (
    <div className="workspace">
      {console_.error && (
        <p className="error-text">
          {console_.error}{' '}
          <button type="button" className="btn-ghost btn-sm" onClick={console_.clearError}>
            dismiss
          </button>
        </p>
      )}

      <Pane
        title="Runners"
        actions={
          <div className="form-row">
            <input
              placeholder="name (e.g. laptop)"
              value={runnerName}
              onChange={(e) => setRunnerName(e.target.value)}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={!!console_.busy}
              onClick={() =>
                void console_
                  .createRunner(runnerName.trim())
                  .then((identity) => {
                    setRunnerName('')
                    setIdentityCopied(false)
                    setRevealedIdentity(identity)
                  })
                  .catch(() => {})
              }
            >
              New runner
            </Button>
          </div>
        }
      >
        <p className="muted">
          A runner is a machine credential: it can fetch and decrypt the agents sealed to it, nothing else. Revoking it
          cuts that machine off immediately.
        </p>
        {console_.runners.length === 0 && <p className="muted">No runners yet.</p>}
        {console_.runners.map((runner) => (
          <div key={runner.id} className="form-row" style={{ alignItems: 'center', gap: '0.6rem' }}>
            <StatusDot tone={runner.revoked ? 'err' : runner.last_seen ? 'ok' : 'warn'}
              title={runner.revoked ? 'Revoked' : runner.last_seen ? `Last seen ${new Date(runner.last_seen).toLocaleString()}` : 'Never connected'}>
              <span>
                {runner.name ?? short(runner.id)} <span className="mono muted">({short(runner.id)})</span>
              </span>
            </StatusDot>
            <span className="muted">
              runtime {runner.runtime_version}
              {runner.last_seen ? ` · seen ${new Date(runner.last_seen).toLocaleTimeString()}` : ' · never connected'}
            </span>
            {!runner.revoked && (
              <Button size="sm" variant="danger" disabled={!!console_.busy} onClick={() => void console_.revokeRunner(runner.id).catch(() => {})}>
                Revoke
              </Button>
            )}
          </div>
        ))}
      </Pane>

      <Pane
        title="Agents"
        actions={
          <div className="form-row">
            <input placeholder="name (e.g. scout)" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
            <Button
              variant="primary"
              size="sm"
              disabled={!!console_.busy}
              onClick={() =>
                void console_
                  .createAgent(agentName.trim())
                  .then((record) => {
                    setAgentName('')
                    setSelectedId(record.id)
                  })
                  .catch(() => {})
              }
            >
              New agent
            </Button>
          </div>
        }
      >
        {console_.agents.length === 0 && <p className="muted">No agents yet — create one, configure it, then start it.</p>}
        {console_.agents.map((agent) => (
          <div key={agent.id} className="form-row" style={{ alignItems: 'center', gap: '0.6rem' }}>
            <StatusDot tone={agent.revoked ? 'err' : agent.desired_state === 'running' ? 'ok' : 'warn'} title={agent.revoked ? 'Revoked' : agent.desired_state}>
              <button type="button" className="address-button" onClick={() => selectAgent(agent)}>
                #{agent.index} {agent.name ?? 'unnamed'}
              </button>
            </StatusDot>
            <span className="mono muted">{short(agent.stellar_public_key)}</span>
            {!agent.revoked && (
              <>
                <Button
                  size="sm"
                  disabled={!!console_.busy}
                  onClick={() =>
                    void console_.setDesiredState(agent.id, agent.desired_state === 'running' ? 'stopped' : 'running').catch(() => {})
                  }
                >
                  {agent.desired_state === 'running' ? 'Stop' : 'Start'}
                </Button>
                <Button size="sm" variant="danger" disabled={!!console_.busy} onClick={() => void console_.revokeAgent(agent.id).catch(() => {})}>
                  Revoke
                </Button>
              </>
            )}
          </div>
        ))}
      </Pane>

      {selected && (
        <Pane
          title={`#${selected.index} ${selected.name ?? 'unnamed'}`}
          actions={
            <div className="form-row">
              <Button size="sm" variant={selectedTab === 'config' ? 'primary' : 'default'} onClick={() => setSelectedTab('config')}>
                Config
              </Button>
              <Button size="sm" variant={selectedTab === 'logs' ? 'primary' : 'default'} onClick={() => setSelectedTab('logs')}>
                Sessions & logs
              </Button>
            </div>
          }
        >
          {selectedTab === 'config' ? (
            configLoaded ? (
              <ConfigEditor
                key={`${selected.id}:${selectedConfig ? 'loaded' : 'fresh'}`}
                agent={selected}
                allAgents={console_.agents}
                initial={selectedConfig}
                busy={!!console_.busy}
                onSave={(config) => console_.saveConfig(selected.id, config).then(() => setSelectedConfig(config))}
              />
            ) : (
              <p className="muted">Loading config…</p>
            )
          ) : (
            <LogsPanel key={selected.id} agent={selected} loadSessions={console_.sessions} loadLogs={console_.sessionLogs} />
          )}
        </Pane>
      )}

      {revealedIdentity && (
        <Modal title="Runner identity — copy it now" onClose={() => setRevealedIdentity(null)}>
          <div className="stack">
            <p>
              This is the runner's <strong>MOSAIC_IDENTITY</strong>. It is shown <strong>once</strong> and never stored on
              the server. Anyone holding it can run your agents until the runner is revoked — treat it like a password.
            </p>
            <Field id="runner-identity" label="Launch command (Node ≥ 22 + npx)">
              <textarea readOnly rows={5} className="mono" value={launchCommand(revealedIdentity)} />
            </Field>
            <p className="muted">
              Set the provider API key env your agents need (OPENAI_API_KEY and/or ANTHROPIC_API_KEY); keys are never
              stored — they only travel through the daemon's environment.
            </p>
            <div className="form-row">
              <Button
                variant="primary"
                onClick={() =>
                  void navigator.clipboard.writeText(launchCommand(revealedIdentity)).then(() => setIdentityCopied(true))
                }
              >
                {identityCopied ? 'Copied ✓' : 'Copy command'}
              </Button>
              <Button onClick={() => setRevealedIdentity(null)}>Done</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
