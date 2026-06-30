import { useState } from 'react'
import type { Desk } from '../api'
import type { Note } from '../notes'
import ShieldForm from './ShieldForm'
import ShieldFromBaseForm from './ShieldFromBaseForm'
import UnshieldForm from './UnshieldForm'

type TransferMode = 'shield' | 'base' | 'unshield'

export default function ShieldUnshieldPanel({
  desk,
  notes,
  userPubkey,
  disabledReason,
  trustless = false,
  onRecheck,
  onDone,
}: {
  desk: Desk
  notes: Note[]
  userPubkey: string | null
  disabledReason: string | null
  trustless?: boolean
  onRecheck?: () => Promise<void>
  onDone: () => void
}) {
  const [mode, setMode] = useState<TransferMode>('shield')
  const activeMode = trustless && mode === 'base' ? 'shield' : mode

  return (
    <>
      <h2>Shield assets</h2>
      <p className="muted">
        Choose where funds come from. Every shield creates a private note in this desk’s Stellar
        settlement contract.
      </p>
      {disabledReason && (
        <div className="card" role="alert">
          <strong>Fund actions unavailable.</strong> <span className="muted">{disabledReason}</span>
          {onRecheck && (
            <button type="button" style={{ marginLeft: 10 }} onClick={() => void onRecheck()}>
              Recheck contract
            </button>
          )}
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="Shield or unshield assets">
        <button
          type="button"
          className={`tab${activeMode === 'shield' ? ' active' : ''}`}
          role="tab"
          id="shield-tab"
          aria-selected={activeMode === 'shield'}
          aria-controls="asset-transfer-panel"
          onClick={() => setMode('shield')}
        >
          From Stellar
        </button>
        {!trustless && (
          <button
            type="button"
            className={`tab${activeMode === 'base' ? ' active' : ''}`}
            role="tab"
            id="base-tab"
            aria-selected={activeMode === 'base'}
            aria-controls="asset-transfer-panel"
            onClick={() => setMode('base')}
          >
            From Base
          </button>
        )}
        <button
          type="button"
          className={`tab${activeMode === 'unshield' ? ' active' : ''}`}
          role="tab"
          id="unshield-tab"
          aria-selected={activeMode === 'unshield'}
          aria-controls="asset-transfer-panel"
          onClick={() => setMode('unshield')}
        >
          Unshield to Stellar
        </button>
      </div>

      <div
        id="asset-transfer-panel"
        role="tabpanel"
        aria-labelledby={`${activeMode}-tab`}
        className="tab-panel"
      >
        {activeMode === 'base' ? (
          <ShieldFromBaseForm
            desk={desk}
            userPubkey={userPubkey}
            disabledReason={disabledReason}
            onDone={onDone}
          />
        ) : userPubkey ? (
          activeMode === 'shield' ? (
            <ShieldForm
              desk={desk}
              userPubkey={userPubkey}
              disabledReason={disabledReason}
              trustless={trustless}
              onDone={onDone}
            />
          ) : (
            <UnshieldForm
              key={userPubkey}
              desk={desk}
              notes={notes}
              userPubkey={userPubkey}
              disabledReason={disabledReason}
              trustless={trustless}
              onDone={onDone}
            />
          )
        ) : (
          <p className="muted">Connect your wallet to {activeMode} assets.</p>
        )}
      </div>
    </>
  )
}
