import { useWallet } from '../WalletContext'
import RecoveryPanel from '../components/RecoveryPanel'

export default function SettingsPage() {
  const { address } = useWallet()

  return (
    <div className="reading">
      <h2>Settings</h2>
      {!address ? (
        <p className="muted">Connect Stellar to manage private-note recovery backups.</p>
      ) : (
        <RecoveryPanel />
      )}
    </div>
  )
}
