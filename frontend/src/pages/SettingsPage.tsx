import { useState } from 'react'
import { errorMessage } from '@mosaic/sdk'
import { useWallet } from '../WalletContext'
import { useEthereumWallet } from '../EthereumWalletContext'
import RecoveryPanel from '../components/RecoveryPanel'
import { api } from '../api'
import { resetBrowserData, withTimeout } from '../resetBrowserData'

export default function SettingsPage() {
  const { address, disconnect } = useWallet()
  const ethWallet = useEthereumWallet()
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  async function handleResetEverything() {
    if (!window.confirm('This logs you out and deletes every locally stored Mosaic value in this browser (notes, wallet backups, cached desks, session, cookies) and cannot be undone. Continue?')) return
    setResetError(null)
    setResetting(true)
    try {
      // Best-effort server-side logout, but `fetch` has no default timeout — a hung MCP request
      // must never leave the button stuck on "Resetting…" forever, so it's bounded like every step
      // inside resetBrowserData(). The local wipe below is what actually matters.
      await withTimeout(api.deleteAuthSession(), 3000, 'deleteAuthSession').catch((e) => console.error('[mosaic] deleteAuthSession did not finish cleanly', e))
      await resetBrowserData()
      // resetBrowserData() just ran localStorage.clear(), which also wiped the "wallet
      // disconnected" flags each context uses to skip its auto-reconnect-on-load check — without
      // re-marking both wallets disconnected here, the reload below would silently sign back in
      // (Freighter/MetaMask still authorize this origin independently of our own storage).
      await disconnect()
      await ethWallet.disconnect()
      window.location.href = '/'
    } catch (e) {
      setResetError(errorMessage(e))
      setResetting(false)
    }
  }

  return (
    <div className="reading">
      <h2>Settings</h2>
      {!address ? (
        <p className="muted">Connect Stellar to manage private-note recovery backups.</p>
      ) : (
        <RecoveryPanel />
      )}
      <section className="card" style={{ marginBottom: 16 }}>
        <strong>Danger zone</strong>
        <p className="muted">
          Deletes every value this app stores in this browser — IndexedDB (notes, cached desks,
          event-replay state), localStorage, sessionStorage, cookies, and any cached backend
          session — and reloads to the home page. Wallet backups saved server-side (recovery) are
          unaffected; anything local-only is gone for good.
        </p>
        <div className="row">
          <button disabled={resetting} onClick={() => void handleResetEverything()}>
            {resetting ? 'Resetting…' : 'Reset all local data'}
          </button>
          {resetError && <span className="err">{resetError}</span>}
        </div>
      </section>
    </div>
  )
}
