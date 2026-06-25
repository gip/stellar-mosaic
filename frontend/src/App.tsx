import { Link, Outlet } from 'react-router-dom'
import { useWallet } from './WalletContext'
import RecoveryPanel from './components/RecoveryPanel'
import ActivityDrawer from './components/ActivityDrawer'
import { useEthereumWallet } from './EthereumWalletContext'

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : addr
}

export default function App() {
  const { address, connect, disconnect, connecting, error } = useWallet()
  const ethereum = useEthereumWallet()
  return (
    <>
      <header className="topbar">
        <h1>
          <Link to="/">STELLAR MOSAIC</Link>
        </h1>
        <nav className="topnav">
          <Link to="/">Desks</Link>
          <Link to="/assets">Assets</Link>
        </nav>
        <div className="wallet-stack">
          <div className="wallet-chain">
            <span className="chain-label">Stellar Testnet</span>
            {address ? (
              <div className="wallet-controls">
                <button className="address-button mono" type="button" title={`Copy ${address}`} onClick={() => void navigator.clipboard.writeText(address)}>
                  {short(address)}
                </button>
                <button type="button" onClick={() => void disconnect()}>Log out</button>
              </div>
            ) : (
              <button type="button" onClick={() => void connect()} disabled={connecting}>
                {connecting ? 'Connecting…' : 'Connect Stellar'}
              </button>
            )}
          </div>
          <div className="wallet-chain">
            <span className="chain-label">Base Sepolia</span>
            {ethereum.address ? (
              <div className="wallet-controls">
                <button className="address-button mono" type="button" title={`Copy ${ethereum.address}`} onClick={() => void navigator.clipboard.writeText(ethereum.address!)}>
                  {short(ethereum.address)}
                </button>
                {!ethereum.connectedToBase && <span className="err">Wrong network</span>}
                <button type="button" onClick={ethereum.disconnect}>Disconnect</button>
              </div>
            ) : (
              <button type="button" onClick={() => void ethereum.connect().catch(() => {})} disabled={!address || ethereum.connecting}>
                {ethereum.connecting ? 'Connecting…' : 'Connect Ethereum'}
              </button>
            )}
          </div>
          {error && <span className="err">{error}</span>}
          {ethereum.error && <span className="err">{ethereum.error}</span>}
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
