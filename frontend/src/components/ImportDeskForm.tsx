import { useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { api } from '../api'

export default function ImportDeskForm({ onDone }: { onDone: () => void }) {
  const [share, setShare] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.importDeskShare(share)
      setShare('')
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 560 }}>
      <label>Desk share code</label>
      <textarea
        className="mono"
        value={share}
        onChange={(e) => setShare(e.target.value)}
        rows={7}
        required
        style={{ width: '100%' }}
      />
      {error && <p className="err">{error}</p>}
      <p>
        <button type="submit" disabled={busy}>
          {busy ? 'Verifying…' : 'Import desk'}
        </button>
      </p>
    </form>
  )
}
