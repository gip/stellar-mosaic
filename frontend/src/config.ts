const DEFAULT_SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org'
const DEFAULT_MCP_URL = 'http://127.0.0.1:8788/mcp'

function absoluteHttpUrl(value: unknown, fallback: string, label: string): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  const candidate = raw || fallback
  if (/^https?:\/\//i.test(candidate)) return candidate
  console.warn(`${label} must be an absolute http(s) URL; using ${fallback}`)
  return fallback
}

export const SOROBAN_RPC_URL = absoluteHttpUrl(
  import.meta.env.VITE_SOROBAN_RPC,
  DEFAULT_SOROBAN_RPC_URL,
  'VITE_SOROBAN_RPC',
)

export const MCP_URL = absoluteHttpUrl(import.meta.env.VITE_MCP_URL, DEFAULT_MCP_URL, 'VITE_MCP_URL')
