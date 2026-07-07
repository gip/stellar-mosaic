// Sessions + logs viewer for one agent. The master token sees private entries; the "public feed"
// link is the unauthenticated view anyone can read.

import { useCallback, useEffect, useState } from 'react'
import type { AgentRecord, AgentSessionRecord, LogEntry } from '@mosaic/agent-sdk/derive'
import { AGENT_BACKEND_URL } from '../config'
import Button from '../components/ui/Button'

function when(ms: number | undefined): string {
  return ms ? new Date(ms).toLocaleString() : '—'
}

export default function LogsPanel({
  agent,
  loadSessions,
  loadLogs,
}: {
  agent: AgentRecord
  loadSessions: (agentId: string) => Promise<AgentSessionRecord[]>
  loadLogs: (sessionId: string) => Promise<LogEntry[]>
}) {
  // The parent keys this panel by agent id, so a selection change remounts with clean state.
  const [sessions, setSessions] = useState<AgentSessionRecord[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await loadSessions(agent.id)
      setSessions(next)
      setError(null)
      if (next.length) setSelected((prev) => prev ?? next[0].id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [agent.id, loadSessions])

  useEffect(() => {
    let active = true
    loadSessions(agent.id)
      .then((next) => {
        if (!active) return
        setSessions(next)
        if (next.length) setSelected((prev) => prev ?? next[0].id)
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      active = false
    }
  }, [agent.id, loadSessions])

  useEffect(() => {
    if (!selected) return
    let active = true
    loadLogs(selected)
      .then((entries) => active && setLogs(entries))
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      active = false
    }
  }, [selected, loadLogs])

  const publicFeed = `${AGENT_BACKEND_URL}/v1/logs/public?agent_id=${agent.id}`

  return (
    <div className="stack">
      <div className="form-row">
        <Button size="sm" onClick={() => void refresh()}>
          Refresh
        </Button>
        <a className="muted" href={publicFeed} target="_blank" rel="noreferrer">
          Public feed ↗
        </a>
      </div>
      {error && <p className="error-text">{error}</p>}
      {sessions && sessions.length === 0 && <p className="muted">No sessions yet — start the agent from a runner.</p>}
      {sessions && sessions.length > 0 && (
        <div className="form-row">
          <select value={selected ?? ''} onChange={(e) => setSelected(e.target.value)}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {when(s.started_at)} · {s.log_count} entries{s.ended_at ? ' · ended' : ' · live'}
              </option>
            ))}
          </select>
        </div>
      )}
      {logs && (
        <div className="log-list mono" style={{ maxHeight: 360, overflowY: 'auto', fontSize: '0.85em' }}>
          {logs.map((entry) => (
            <details key={entry.cursor} open={entry.kind !== 'log'}>
              <summary>
                #{entry.seq} {entry.kind} · {entry.visibility} · {when(entry.at)}
              </summary>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(entry.payload, null, 2)}</pre>
            </details>
          ))}
          {logs.length === 0 && <p className="muted">No entries in this session yet.</p>}
        </div>
      )}
    </div>
  )
}
