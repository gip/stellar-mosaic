import { useState } from 'react'
import { Networks } from '@stellar/stellar-sdk'
import { errorMessage } from '@mosaic/sdk'
import type { Desk } from '../api'
import { encodeDeskShare } from '../deskShare'
import Button from './ui/Button'

export default function DeskShareButton({ desk }: { desk: Desk }) {
  const [share, setShare] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function copy() {
    setBusy(true)
    setStatus(null)
    try {
      const next = await encodeDeskShare(desk, Networks.TESTNET)
      setShare(next)
      await navigator.clipboard.writeText(next)
      setStatus('Copied')
    } catch (error) {
      if (share) setStatus(errorMessage(error))
      else {
        try {
          const next = await encodeDeskShare(desk, Networks.TESTNET)
          setShare(next)
          setStatus('Copy manually')
        } catch (inner) {
          setStatus(errorMessage(inner))
        }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="desk-share">
      <Button size="sm" variant="ghost" onClick={copy} disabled={busy}>
        {busy ? 'Preparing…' : 'Copy share code'}
      </Button>
      {status && <span className={status === 'Copied' ? 'muted' : 'err'}>{status}</span>}
      {share && status !== 'Copied' && (
        <textarea
          className="mono desk-share-fallback"
          value={share}
          readOnly
          rows={4}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
    </div>
  )
}
