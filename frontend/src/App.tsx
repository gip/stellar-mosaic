import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useWallet } from './WalletContext'
import { RecoveryNotice } from './components/RecoveryPanel'
import ActivityDrawer from './components/ActivityDrawer'
import StatusDot from './components/ui/StatusDot'
import ThemeToggle from './components/ui/ThemeToggle'
import { useEthereumWallet } from './EthereumWalletContext'
import { useMosaicServer } from './MosaicServerContext'
import { useStorageMode } from './StorageModeContext'

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : addr
}

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'active' : ''
}

export default function App() {
  const { address, connect, disconnect, connecting, error } = useWallet()
  const ethereum = useEthereumWallet()
  const mosaicServer = useMosaicServer()
  const storageMode = useStorageMode()
  const [dismissed, setDismissed] = useState<string[]>([])
  const navigate = useNavigate()
  const location = useLocation()

  // A desk only exists in one data mode, so leaving that mode should not keep us
  // on its now-stale desk page — send the user back home instead.
  useEffect(() => {
    function onModeChanged() {
      if (location.pathname.startsWith('/desk/')) navigate('/')
    }
    window.addEventListener('mosaic-storage-mode-changed', onModeChanged)
    return () => window.removeEventListener('mosaic-storage-mode-changed', onModeChanged)
  }, [location.pathname, navigate])

  async function logOutStellar() {
    await mosaicServer.disconnect().catch(() => {})
    await disconnect()
    navigate('/')
  }

  const errors = useMemo(
    () => [error, mosaicServer.error, ethereum.error].filter((e): e is string => !!e),
    [error, mosaicServer.error, ethereum.error],
  )
  const activeErrors = errors.filter((e) => !dismissed.includes(e))

  return (
    <>
      <header className="topbar">
        <h1 className="brand">
          <Link to="/">
            <span className="brand-word">MOSAIC</span>
            <span className="brand-logo" role="img" aria-label="Mosaic logo" />
          </Link>
        </h1>
        <nav className="topnav">
          <NavLink to="/" end className={navClass}>
            Desks
          </NavLink>
          <NavLink to="/overview" className={navClass}>
            Overview
          </NavLink>
          <NavLink to="/assets" className={navClass}>
            Assets
          </NavLink>
          {address && (
            <NavLink to="/activity" className={navClass}>
              Activity
            </NavLink>
          )}
        </nav>
        <div className="topbar-spacer" />
        <div className="wallet-stack">
          <div className="wallet-chain">
            <span className="chain-label">Stellar Testnet</span>
            {address ? (
              <div className="wallet-controls">
                <StatusDot tone="ok" title="Connected">
                  <button
                    className="address-button mono"
                    type="button"
                    title={`Copy ${address}`}
                    onClick={() => void navigator.clipboard.writeText(address)}
                  >
                    {short(address)}
                  </button>
                </StatusDot>
                <button type="button" onClick={() => void logOutStellar()}>
                  Log out
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => void connect()} disabled={connecting}>
                {connecting ? 'Connecting…' : 'Connect Stellar'}
              </button>
            )}
          </div>
          <div className="wallet-chain">
            <span className="chain-label">Trust mode</span>
            <div className="wallet-controls segmented">
              <button
                type="button"
                aria-pressed={storageMode.mode === 'trustless'}
                disabled={!address || storageMode.connecting}
                title={address ? 'Use browser-local desk data and self-submitted workflows' : 'Connect Stellar first'}
                onClick={() => void storageMode.setMode('trustless')}
              >
                Trustless
              </button>
              <button
                type="button"
                aria-pressed={storageMode.mode === 'trusted'}
                disabled={!address || mosaicServer.connecting}
                title={address ? 'Use Mosaic Server SQLite-backed data and sponsored workflows' : 'Connect Stellar first'}
                onClick={() => void mosaicServer.trust()}
              >
                {mosaicServer.connecting && storageMode.mode !== 'trusted' ? 'Connecting…' : 'Trusted'}
              </button>
            </div>
          </div>
          <div className="wallet-chain">
            <span className="chain-label">Base Sepolia</span>
            {ethereum.address ? (
              <div className="wallet-controls">
                <StatusDot tone={ethereum.connectedToBase ? 'ok' : 'warn'} title={ethereum.connectedToBase ? 'Connected' : 'Wrong network'}>
                  <button
                    className="address-button mono"
                    type="button"
                    title={`Copy ${ethereum.address}`}
                    onClick={() => void navigator.clipboard.writeText(ethereum.address!)}
                  >
                    {short(ethereum.address)}
                  </button>
                </StatusDot>
                {!ethereum.connectedToBase && <span className="warn">Wrong network</span>}
                <button type="button" onClick={ethereum.disconnect}>
                  Disconnect
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => void ethereum.connect().catch(() => {})} disabled={!address || ethereum.connecting}>
                {ethereum.connecting ? 'Connecting…' : 'Connect Ethereum'}
              </button>
            )}
          </div>
        </div>
        <div className="topbar-actions">
          <ThemeToggle />
          <button
            type="button"
            className="topbar-icon-link"
            onClick={() => navigate('/settings')}
            disabled={!address}
            title={address ? 'Settings' : 'Connect Stellar to open settings'}
            aria-label="Settings"
          >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
          </button>
        </div>
      </header>
      <main className="app-main">
        {address && (
          <div className="banner info demo-recovery-reminder" role="status">
            <div className="banner-body">
              {storageMode.mode === 'trusted'
                ? 'Trusted mode: your private notes are synced to the Mosaic Server backup. This demo keeps no other copy — export your own backup, because losing that server data means losing the funds.'
                : 'Trustless mode: your private notes live only in this browser and are never backed up. Clearing storage or losing this device means losing the funds.'}
            </div>
          </div>
        )}
        {activeErrors.length > 0 && (
          <div className="banner err" role="alert" style={{ marginBottom: 'var(--sp-4)' }}>
            <div className="banner-body">
              {activeErrors.map((e) => (
                <div key={e}>{e}</div>
              ))}
            </div>
            <button
              type="button"
              className="btn-ghost btn-sm"
              aria-label="Dismiss"
              onClick={() => setDismissed((d) => [...d, ...activeErrors])}
            >
              ✕
            </button>
          </div>
        )}
        <RecoveryNotice />
        <Outlet />
      </main>
      {address && <ActivityDrawer />}
    </>
  )
}
