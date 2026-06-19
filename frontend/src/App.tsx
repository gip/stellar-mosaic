import { Link, Outlet } from 'react-router-dom'
import { useWallet } from './WalletContext'

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : addr
}

export default function App() {
  const { address, connect, connecting, error } = useWallet()
  return (
    <>
      <header className="topbar">
        <h1>
          <Link to="/">STELLAR MOSAIC</Link>
        </h1>
        <div>
          {address ? (
            <span className="mono" title={address}>
              {short(address)}
            </span>
          ) : (
            <button onClick={connect} disabled={connecting}>
              {connecting ? 'Connecting…' : 'Connect wallet'}
            </button>
          )}
          {error && <span className="err"> {error}</span>}
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  )
}
