import { useState } from 'react'
import type { Desk } from '../api'
import type { Note } from '../notes'
import ShieldForm from './ShieldForm'
import UnshieldForm from './UnshieldForm'

type TransferMode = 'shield' | 'unshield'

export default function ShieldUnshieldPanel({
  desk,
  notes,
  userPubkey,
  onDone,
}: {
  desk: Desk
  notes: Note[]
  userPubkey: string | null
  onDone: () => void
}) {
  const [mode, setMode] = useState<TransferMode>('shield')

  return (
    <>
      <h2>Shield / Unshield</h2>
      <div className="tabs" role="tablist" aria-label="Shield or unshield assets">
        <button
          type="button"
          className={`tab${mode === 'shield' ? ' active' : ''}`}
          role="tab"
          id="shield-tab"
          aria-selected={mode === 'shield'}
          aria-controls="asset-transfer-panel"
          onClick={() => setMode('shield')}
        >
          Shield
        </button>
        <button
          type="button"
          className={`tab${mode === 'unshield' ? ' active' : ''}`}
          role="tab"
          id="unshield-tab"
          aria-selected={mode === 'unshield'}
          aria-controls="asset-transfer-panel"
          onClick={() => setMode('unshield')}
        >
          Unshield
        </button>
      </div>

      <div
        id="asset-transfer-panel"
        role="tabpanel"
        aria-labelledby={`${mode}-tab`}
        className="tab-panel"
      >
        {userPubkey ? (
          mode === 'shield' ? (
            <ShieldForm desk={desk} userPubkey={userPubkey} onDone={onDone} />
          ) : (
            <UnshieldForm
              key={userPubkey}
              desk={desk}
              notes={notes}
              userPubkey={userPubkey}
              onDone={onDone}
            />
          )
        ) : (
          <p className="muted">Connect your wallet to {mode} assets.</p>
        )}
      </div>
    </>
  )
}
