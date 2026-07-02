import { useEffect, useState } from 'react'
import { Networks } from '@stellar/stellar-sdk'
import { errorMessage } from '@mosaic/sdk'
import type { Desk } from '../api'
import { encodeDeskShare } from '../deskShare'
import Button from './ui/Button'
import Modal from './ui/Modal'

export default function DeskShareButton({ desk }: { desk: Desk }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Share
      </Button>
      {open && <DeskShareModal desk={desk} onClose={() => setOpen(false)} />}
    </>
  )
}

function DeskShareModal({ desk, onClose }: { desk: Desk; onClose: () => void }) {
  const [share, setShare] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    encodeDeskShare(desk, Networks.TESTNET)
      .then((next) => active && setShare(next))
      .catch((e) => active && setError(errorMessage(e)))
    return () => {
      active = false
    }
  }, [desk])

  async function copy() {
    if (!share) return
    try {
      await navigator.clipboard.writeText(share)
      setStatus('Copied')
    } catch {
      setStatus('Copy failed — select the code and copy manually')
    }
  }

  return (
    <Modal title={`Share “${desk.name}”`} onClose={onClose}>
      <p className="muted">
        Send this share code to the parties you trust. They open Mosaic, choose{' '}
        <strong>Import desk</strong>, and paste the code to load this desk with the same assets and
        pairs. Only share it with people you want to have access.
      </p>
      {error && <p className="err">{error}</p>}
      {!share && !error && <p className="muted">Preparing share code…</p>}
      {share && (
        <>
          <textarea
            className="mono desk-share-fallback"
            value={share}
            readOnly
            rows={4}
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="row" style={{ alignItems: 'center', gap: 'var(--sp-2)', marginTop: 'var(--sp-2)' }}>
            <Button size="sm" onClick={copy}>
              Copy share code
            </Button>
            {status && <span className={status === 'Copied' ? 'muted' : 'err'}>{status}</span>}
          </div>
        </>
      )}
    </Modal>
  )
}
