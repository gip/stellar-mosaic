import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const configDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(configDir, '..')
const bbJsRoot = realpathSync(resolve(configDir, 'node_modules/@aztec/bb.js'))

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      allow: [repoRoot, bbJsRoot],
    },
  },
})
