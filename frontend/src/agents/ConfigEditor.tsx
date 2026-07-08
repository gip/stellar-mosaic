// Per-agent config editor: prompt (preset or custom), provider/model, run params, peer picker
// ("who they can connect to" — other registered identities), and the desk asset/pair universe.
// Saves the reserved `agent-config` attached-data key the runtime consumes.

import { useState } from 'react'
import { PROMPT_PRESETS, type AgentConfig, type AgentRecord } from '@mosaic/agent-sdk/derive'
import Button from '../components/ui/Button'
import Field from '../components/ui/Field'

const DESK_TEMPLATE = JSON.stringify(
  {
    assets: [
      { symbol: 'XLM' },
      { symbol: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    ],
    pairs: [{ base: 'XLM', quote: 'USDC' }],
  },
  null,
  2,
)

/** Form state is initialized from `initial` on mount — the parent re-keys this component per
 *  (agent, loaded config), so a selection change remounts with fresh values. */
export default function ConfigEditor({
  agent,
  allAgents,
  initial,
  busy,
  onSave,
}: {
  agent: AgentRecord
  allAgents: AgentRecord[]
  initial: AgentConfig | null
  busy: boolean
  onSave: (config: AgentConfig) => Promise<void>
}) {
  const [preset, setPreset] = useState<string>(() =>
    initial ? (initial.prompt.custom ? 'custom' : (initial.prompt.preset ?? 'custom')) : 'custom',
  )
  const [custom, setCustom] = useState(() => initial?.prompt.custom ?? '')
  const [provider, setProvider] = useState<'openai' | 'anthropic'>(() => initial?.provider ?? 'openai')
  const [model, setModel] = useState(() => initial?.model ?? '')
  const [maxTurns, setMaxTurns] = useState(() => String(initial?.params?.maxTurns ?? 80))
  const [timeoutMinutes, setTimeoutMinutes] = useState(() => String(initial?.params?.timeoutMinutes ?? 45))
  const [webSearch, setWebSearch] = useState(() => initial?.params?.webSearch ?? false)
  const [logVisibility, setLogVisibility] = useState<'public' | 'private'>(() => initial?.params?.logVisibility ?? 'private')
  const [peers, setPeers] = useState<string[]>(() =>
    (initial?.peers ?? [])
      .map((p) => allAgents.find((a) => a.stellar_public_key === p.stellar_public_key)?.id)
      .filter((id): id is string => !!id),
  )
  const [deskJson, setDeskJson] = useState(() => (initial?.desk ? JSON.stringify(initial.desk, null, 2) : DESK_TEMPLATE))
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const candidatePeers = allAgents.filter((a) => a.id !== agent.id && !a.revoked)

  async function save() {
    setSaveError(null)
    setSaved(false)
    try {
      let desk: AgentConfig['desk']
      try {
        desk = JSON.parse(deskJson) as AgentConfig['desk']
      } catch {
        throw new Error('Desk JSON is not valid JSON.')
      }
      if (!desk || !Array.isArray(desk.assets) || !Array.isArray(desk.pairs)) {
        throw new Error('Desk JSON needs "assets" and "pairs" arrays.')
      }
      if (!model.trim()) throw new Error('Model is required (e.g. gpt-5, claude-sonnet-5).')
      if (preset === 'custom' && !custom.trim()) throw new Error('Write a custom prompt or pick a preset.')
      const config: AgentConfig = {
        version: 1,
        prompt: preset === 'custom' ? { custom: custom.trim() } : { preset },
        provider,
        model: model.trim(),
        params: {
          maxTurns: Number(maxTurns) || 80,
          timeoutMinutes: Number(timeoutMinutes) || 45,
          webSearch,
          logVisibility,
        },
        peers: peers
          .map((id) => allAgents.find((a) => a.id === id))
          .filter((a): a is AgentRecord => !!a)
          .map((a) => ({
            name: a.name ?? `agent-${a.index}`,
            eth_address: a.eth_address,
            stellar_public_key: a.stellar_public_key,
          })),
        desk,
      }
      await onSave(config)
      setSaved(true)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="stack">
      <Field id="agent-prompt-preset" label="Prompt">
        <select value={preset} onChange={(e) => setPreset(e.target.value)}>
          <option value="custom">Custom…</option>
          {Object.entries(PROMPT_PRESETS).map(([id, p]) => (
            <option key={id} value={id}>
              {p.title}
            </option>
          ))}
        </select>
      </Field>
      {preset === 'custom' ? (
        <Field id="agent-prompt-custom" label="Custom mandate" help="What this agent should try to do.">
          <textarea rows={4} value={custom} onChange={(e) => setCustom(e.target.value)} />
        </Field>
      ) : (
        <p className="muted">{PROMPT_PRESETS[preset]?.prompt}</p>
      )}
      <div className="form-row">
        <Field id="agent-provider" label="Provider">
          <select value={provider} onChange={(e) => setProvider(e.target.value as 'openai' | 'anthropic')}>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </Field>
        <Field id="agent-model" label="Model" help="e.g. gpt-5 or claude-sonnet-5" required>
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-5" />
        </Field>
      </div>
      <div className="form-row">
        <Field id="agent-max-turns" label="Max turns">
          <input type="number" min={4} max={400} value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} />
        </Field>
        <Field id="agent-timeout" label="Timeout (min)">
          <input type="number" min={1} max={720} value={timeoutMinutes} onChange={(e) => setTimeoutMinutes(e.target.value)} />
        </Field>
        <Field id="agent-log-visibility" label="Session logs">
          <select value={logVisibility} onChange={(e) => setLogVisibility(e.target.value as 'public' | 'private')}>
            <option value="private">Private (master only)</option>
            <option value="public">Public</option>
          </select>
        </Field>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={webSearch} onChange={(e) => setWebSearch(e.target.checked)} /> Allow provider web
        search (billed per search)
      </label>
      <Field
        id="agent-peers"
        label="Can connect to"
        help={candidatePeers.length ? 'Peers this agent may negotiate with over XMTP.' : 'Create more agents to pick peers.'}
      >
        <div className="stack-sm">
          {candidatePeers.map((a) => (
            <label key={a.id} className="checkbox">
              <input
                type="checkbox"
                checked={peers.includes(a.id)}
                onChange={(e) => setPeers((prev) => (e.target.checked ? [...prev, a.id] : prev.filter((id) => id !== a.id)))}
              />{' '}
              {a.name ?? `agent-${a.index}`} <span className="mono muted">({a.stellar_public_key.slice(0, 8)}…)</span>
            </label>
          ))}
        </div>
      </Field>
      <Field
        id="agent-desk"
        label="Desk (assets & pairs)"
        help="The trading universe. Asset ids follow declaration order; omit issuer for native XLM."
      >
        <textarea rows={8} className="mono" value={deskJson} onChange={(e) => setDeskJson(e.target.value)} />
      </Field>
      {saveError && <p className="error-text">{saveError}</p>}
      {saved && <p className="muted">Saved.</p>}
      <div>
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          Save config
        </Button>
      </div>
    </div>
  )
}
