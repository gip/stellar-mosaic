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
import { WalletProvider } from './WalletContext'
import { RecoveryProvider } from './RecoveryContext'
import { ActivityProvider } from './ActivityContext'

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: 'desk/:deskId', element: <DeskPage /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WalletProvider>
      <RecoveryProvider>
        <ActivityProvider>
          <RouterProvider router={router} />
        </ActivityProvider>
      </RecoveryProvider>
    </WalletProvider>
  </StrictMode>,
)
