import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Proxy `/api/*` to the Rust backend in dev so the browser talks same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.MOSAIC_BACKEND ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})
