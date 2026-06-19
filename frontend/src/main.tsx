import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import App from './App'
import Home from './pages/Home'
import DeskPage from './pages/DeskPage'
import { WalletProvider } from './WalletContext'

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
      <RouterProvider router={router} />
    </WalletProvider>
  </StrictMode>,
)
