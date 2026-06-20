import { Link, Outlet } from 'react-router-dom'
import { useWallet } from './WalletContext'
import RecoveryPanel from './components/RecoveryPanel'
import ActivityDrawer from './components/ActivityDrawer'

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : addr
}

export default function App() {
  const { address, connect, disconnect, connecting, error } = useWallet()
  return (
    <>
      <header className="topbar">
        <h1>
          <Link to="/">STELLAR MOSAIC</Link>
        </h1>
        <div>
          {address ? (
            <div className="wallet-controls">
              <span className="mono" title={address}>
                {short(address)}
              </span>
              <button type="button" onClick={disconnect}>
                Log out
              </button>
            </div>
          ) : (
            <button type="button" onClick={connect} disabled={connecting}>
              {connecting ? 'Connecting…' : 'Connect wallet'}
            </button>
          )}
          {error && <span className="err"> {error}</span>}
        </div>
      </header>
      <main>
        <RecoveryPanel />
        <Outlet />
      </main>
      <ActivityDrawer />
    </>
  )
}
