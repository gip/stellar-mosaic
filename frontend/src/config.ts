const DEFAULT_SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org'
const DEFAULT_MCP_URL = 'http://127.0.0.1:8788/mcp'
const DEFAULT_BASE_ROUTER_ID = 'CB3ISULTPMQXHUH6BVRO7VQIQE3TTDRGSHWBJ72V7GRO6VF63BMGNWOU'

function absoluteHttpUrl(value: unknown, fallback: string, label: string): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  const candidate = raw || fallback
  if (/^https?:\/\//i.test(candidate)) return candidate
  console.warn(`${label} must be an absolute http(s) URL; using ${fallback}`)
  return fallback
}

function mcpUrl(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  const candidate = raw || fallback
  if (/^https?:\/\//i.test(candidate) || candidate.startsWith('/')) return candidate
  console.warn(`VITE_MCP_URL must be an absolute http(s) URL or same-origin path; using ${fallback}`)
  return fallback
}

export const SOROBAN_RPC_URL = absoluteHttpUrl(
  import.meta.env.VITE_SOROBAN_RPC,
  DEFAULT_SOROBAN_RPC_URL,
  'VITE_SOROBAN_RPC',
)

export const MCP_URL = mcpUrl(import.meta.env.VITE_MCP_URL, DEFAULT_MCP_URL)

/** Optional Base Sepolia RPC for read-only custody totals. When unset, viem's built-in transport is
 * used (no wallet required). */
export const BASE_RPC_URL = typeof import.meta.env.VITE_BASE_RPC === 'string' && import.meta.env.VITE_BASE_RPC.trim()
  ? import.meta.env.VITE_BASE_RPC.trim()
  : undefined
export const BASE_ROUTER_ID = typeof import.meta.env.VITE_BASE_ROUTER_ID === 'string' && import.meta.env.VITE_BASE_ROUTER_ID.trim()
  ? import.meta.env.VITE_BASE_ROUTER_ID.trim()
  : DEFAULT_BASE_ROUTER_ID
