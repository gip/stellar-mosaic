import { Buffer } from 'buffer'
// stellar-sdk expects a global Buffer in the browser.
const g = globalThis as unknown as { Buffer?: typeof Buffer }
g.Buffer = g.Buffer ?? Buffer

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import App from './App'
import Home from './pages/Home'
import DeskPage from './pages/DeskPage'
import AssetsPage from './pages/AssetsPage'
import { WalletProvider } from './WalletContext'
import { RecoveryProvider } from './RecoveryContext'
import { ActivityProvider } from './ActivityContext'
import { EthereumWalletProvider } from './EthereumWalletContext'

// eslint-disable-next-line react-refresh/only-export-components
function AppRoute() {
  return (
    <WalletProvider>
      <EthereumWalletProvider>
        <RecoveryProvider>
          <ActivityProvider>
            <App />
          </ActivityProvider>
        </RecoveryProvider>
      </EthereumWalletProvider>
    </WalletProvider>
  )
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppRoute />,
    children: [
      { index: true, element: <Home /> },
      { path: 'assets', element: <AssetsPage /> },
      { path: 'desk/:deskId', element: <DeskPage /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
