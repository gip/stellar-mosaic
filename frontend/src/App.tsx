import { Link, Outlet } from 'react-router-dom'
import { useWallet } from './WalletContext'
import RecoveryPanel from './components/RecoveryPanel'
import ActivityDrawer from './components/ActivityDrawer'
import { useEthereumWallet } from './EthereumWalletContext'
import { useMosaicServer } from './MosaicServerContext'
import { useStorageMode } from './StorageModeContext'

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : addr
}

export default function App() {
  const { address, connect, disconnect, connecting, error } = useWallet()
  const ethereum = useEthereumWallet()
  const mosaicServer = useMosaicServer()
  const storageMode = useStorageMode()

  async function logOutStellar() {
    await mosaicServer.disconnect().catch(() => {})
    await disconnect()
  }

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
                <button type="button" onClick={() => void logOutStellar()}>Log out</button>
              </div>
            ) : (
              <button type="button" onClick={() => void connect()} disabled={connecting}>
                {connecting ? 'Connecting…' : 'Connect Stellar'}
              </button>
            )}
          </div>
          <div className="wallet-chain">
            <span className="chain-label">Data mode</span>
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
          {mosaicServer.error && <span className="err">{mosaicServer.error}</span>}
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
