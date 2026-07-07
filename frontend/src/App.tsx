import { useEffect, useMemo, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useWallet } from './WalletContext'
import { RecoveryNotice } from './components/RecoveryPanel'
import ActivityDrawer from './components/ActivityDrawer'
import StatusDot from './components/ui/StatusDot'
import ThemeToggle from './components/ui/ThemeToggle'
import { useEthereumWallet } from './EthereumWalletContext'
import { useMosaicServer } from './MosaicServerContext'
import { useStorageMode, type StorageMode } from './StorageModeContext'

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : addr
}

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'active' : ''
}

export default function App() {
  const { address, ready, connect, disconnect, connecting, error } = useWallet()
  const ethereum = useEthereumWallet()
  const mosaicServer = useMosaicServer()
  const storageMode = useStorageMode()
  const [dismissed, setDismissed] = useState<string[]>([])
  const navigate = useNavigate()
  const location = useLocation()

  // A desk only exists in one data mode, so leaving that mode should not keep us on its
  // now-stale desk page — send the user back home instead.
  useEffect(() => {
    function onModeChanged() {
      if (location.pathname.startsWith('/desk/')) navigate('/')
    }
    window.addEventListener('mosaic-storage-mode-changed', onModeChanged)
    return () => window.removeEventListener('mosaic-storage-mode-changed', onModeChanged)
  }, [location.pathname, navigate])

  // The URL decides the mode: /agents runs the console in Agent mode, the trading pages restore
  // the last-used trading mode, /overview and /settings are neutral. The ref makes this fire only
  // when the pathname changes — router navigations are transitions, so a mode change can commit
  // one render before the URL it belongs to, and reacting to that stale pair here would switch
  // the mode right back (the "stuck Connecting… on /" bug). Restoring Trusted can fail (backend
  // session), so it falls back to Trustless instead of retrying forever. Logged out there is no
  // mode (see the /agents → / redirect below).
  const agentMode = !!address && storageMode.mode === 'agent'
  const syncedPathRef = useRef<string | null>(null)
  useEffect(() => {
    if (!ready || !address || storageMode.connecting) return
    const path = location.pathname
    if (syncedPathRef.current === path) return
    syncedPathRef.current = path
    if (path === '/agents') {
      if (storageMode.mode !== 'agent') void storageMode.setMode('agent').catch(() => {})
    } else if (path === '/' || path === '/activity' || path === '/assets' || path.startsWith('/desk/')) {
      if (storageMode.mode === 'agent') {
        void storageMode
          .setMode(storageMode.lastTradingMode)
          .catch(() => storageMode.setMode('trustless').catch(() => {}))
      }
    }
  }, [ready, address, location.pathname, storageMode])

  // The mode toggles express intent through the URL: Agent is entered by navigating to the
  // console (the sync above switches the mode), and picking a trading mode while on the console
  // navigates home.
  function switchMode(next: StorageMode) {
    if (next === 'agent') {
      if (location.pathname !== '/agents') navigate('/agents')
      return
    }
    if (location.pathname === '/agents') navigate('/')
    void storageMode.setMode(next).catch(() => {})
  }

  // The agents console needs a wallet; logged out it is just a connect prompt, so go home.
  // Gated on `ready` so a logged-in reload of /agents is not bounced before the address restores.
  useEffect(() => {
    if (ready && !address && location.pathname === '/agents') {
      navigate('/', { replace: true })
    }
  }, [ready, address, location.pathname, navigate])

  // Storage mode is not touched here: StorageModeContext watches wallet.address and falls
  // back to Trustless in-memory only, so logging out never persists a mode "choice".
  async function logOutStellar() {
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
          <Link to={agentMode ? '/agents' : '/'}>
            <span className="brand-word">MOSAIC</span>
            <span className="brand-logo" role="img" aria-label="Mosaic logo" />
          </Link>
        </h1>
        <nav className="topnav">
          <NavLink to="/" end className={navClass}>
            Desks
          </NavLink>
          <NavLink to="/activity" className={navClass}>
            Activity
          </NavLink>
          <NavLink to="/agents" className={navClass}>
            Agents
          </NavLink>
          <NavLink to="/assets" className={navClass}>
            Assets
          </NavLink>
          <NavLink to="/overview" className={navClass}>
            Overview
          </NavLink>
        </nav>
        <div className="topbar-spacer" />
        <div className="wallet-stack">
          <div className="wallet-chain">
            <span className="chain-label">Mode</span>
            <div className="wallet-controls segmented">
              <button
                type="button"
                aria-pressed={!!address && storageMode.mode === 'trustless'}
                disabled={!address || storageMode.connecting}
                title={address ? 'Use browser-local desk data and self-submitted workflows' : 'Connect Stellar first'}
                onClick={() => switchMode('trustless')}
              >
                Trustless
              </button>
              <button
                type="button"
                aria-pressed={!!address && storageMode.mode === 'trusted'}
                disabled={!address || mosaicServer.connecting}
                title={address ? 'Use Mosaic Server SQLite-backed data and sponsored workflows' : 'Connect Stellar first'}
                onClick={() => switchMode('trusted')}
              >
                {mosaicServer.connecting && storageMode.mode !== 'trusted' ? 'Connecting…' : 'Trusted'}
              </button>
              <button
                type="button"
                aria-pressed={!!address && storageMode.mode === 'agent'}
                disabled={!address || storageMode.connecting}
                title={address ? 'Agent console only: control your agents; trading pages are hidden' : 'Connect Stellar first'}
                onClick={() => switchMode('agent')}
              >
                Agent
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
              <Settings size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </header>
      <main className="app-main">
        {address && (
          <div className="banner info demo-recovery-reminder" role="status">
            <div className="banner-body">
              {storageMode.mode === 'trusted'
                ? 'Trusted mode: your private notes are synced to the Mosaic Server backup. This demo keeps no other copy — export your own backup, because losing that server data means losing the funds.'
                : storageMode.mode === 'agent'
                  ? 'Agent mode: this app is a control panel for your agents. Trading pages are hidden; agent keys are derived in this browser and never leave it.'
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
        {!agentMode && <RecoveryNotice />}
        <Outlet />
      </main>
      {address && !agentMode && <ActivityDrawer />}
    </>
  )
}
