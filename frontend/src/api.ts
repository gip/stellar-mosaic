// Typed client for the Rust backend. All paths go through the Vite `/api` proxy in dev.

export interface Asset {
  asset_id: number
  symbol: string
  token: string
  decimals: number
}

export interface Pair {
  pair_id: number
  base_asset: number
  quote_asset: number
}

export interface Desk {
  id: string
  name: string
  contract_id: string
  sponsor_pubkey: string
  assets: Asset[]
  pairs: Pair[]
}

const BASE = '/api'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export const api = {
  listDesks: () => req<Desk[]>('/desks'),
  getDesk: (id: string) => req<Desk>(`/desks/${id}`),
  getRoot: (id: string) => req<{ root: string }>(`/desks/${id}/root`),
  getBook: (id: string, pair: number, side: number) =>
    req<{ pair: number; side: number; orders: unknown }>(
      `/desks/${id}/book?pair=${pair}&side=${side}`,
    ),
  importDesk: (body: {
    name: string
    contract_id: string
    sponsor_pubkey: string
    assets: Asset[]
    pairs: Pair[]
  }) => req<Desk>('/desks/import', { method: 'POST', body: JSON.stringify(body) }),
}
