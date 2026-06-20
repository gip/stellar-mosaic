import { useState } from 'react'
import { useActivity } from '../ActivityContext'
import type { Operation } from '../api'

const terminal = (operation: Operation) => ['succeeded', 'failed', 'cancelled'].includes(operation.status)

export default function ActivityDrawer() {
  const { operations, connected, error, cancel } = useActivity()
  const [open, setOpen] = useState(false)
  const active = operations.filter((operation) => !terminal(operation))
  return (
    <aside className={`activity-drawer${open ? ' open' : ''}`}>
      <button type="button" className="activity-toggle" onClick={() => setOpen((value) => !value)}>
        Activity{active.length ? ` (${active.length})` : ''}
      </button>
      {open && <div className="activity-panel">
        <h3>Operations</h3>
        {!connected && <p className="muted">Connect and authenticate the wallet to load activity.</p>}
        {error && <p className="err">{error}</p>}
        {operations.length === 0 && connected && <p className="muted">No operations yet.</p>}
        {operations.map((operation) => <div className="activity-item" key={operation.id}>
          <div><strong>{label(operation.kind)}</strong> <span className={`operation-${operation.status}`}>{operation.status.replaceAll('_', ' ')}</span></div>
          <small className="mono">{operation.id.slice(0, 8)}</small>
          {operation.status === 'waiting_for_client' && <div className="muted">Waiting for the unlocked private wallet…</div>}
          {operation.error && <div className="err">{operation.error}</div>}
          {!terminal(operation) && !operation.submitted && <button type="button" onClick={() => void cancel(operation.id)}>Cancel</button>}
        </div>)}
      </div>}
    </aside>
  )
}

function label(kind: Operation['kind']) {
  return ({ shield: 'Shield', place_order: 'Place order', unshield: 'Unshield', cancel_order: 'Cancel order' })[kind]
}
