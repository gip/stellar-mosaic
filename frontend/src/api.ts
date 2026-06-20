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

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

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
    throw new ApiError(res.status, msg)
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
  createDesk: (body: {
    name: string
    assets: { asset_id: number; symbol: string; token: string; decimals: number }[]
    pairs: { base_asset: number; quote_asset: number }[]
  }) => req<Desk>('/desks', { method: 'POST', body: JSON.stringify(body) }),
  getNotes: (id: string) => req<{ notes: ChainNote[] }>(`/desks/${id}/notes`),
  getFills: (id: string) => req<{ fills: Fill[] }>(`/desks/${id}/fills`),
  submitShield: (id: string, tx_xdr: string) =>
    req<{ ok: boolean; result: string }>(`/desks/${id}/shield/submit`, {
      method: 'POST',
      body: JSON.stringify({ tx_xdr }),
    }),
  getNoteProof: (id: string, ownerTag: string) =>
    req<NoteProof>(`/desks/${id}/note-proof?owner_tag=${ownerTag}`),
  relayOrder: (id: string, proof_b64: string, public_inputs_b64: string) =>
    req<{ ok: boolean; result: string }>(`/desks/${id}/relay/order`, {
      method: 'POST',
      body: JSON.stringify({ proof_b64, public_inputs_b64 }),
    }),
  relayJoin: (id: string, proof_b64: string, public_inputs_b64: string) =>
    req<{ ok: boolean; result: string }>(`/desks/${id}/relay/join`, {
      method: 'POST',
      body: JSON.stringify({ proof_b64, public_inputs_b64 }),
    }),
  relayUnshield: (id: string, to: string, proof_b64: string, public_inputs_b64: string) =>
    req<{ ok: boolean; result: string }>(`/desks/${id}/relay/unshield`, {
      method: 'POST',
      body: JSON.stringify({ to, proof_b64, public_inputs_b64 }),
    }),
  relayCancel: (
    id: string,
    pair_id: number,
    side: number,
    proof_b64: string,
    public_inputs_b64: string,
  ) =>
    req<{ ok: boolean; result: string }>(`/desks/${id}/relay/cancel`, {
      method: 'POST',
      body: JSON.stringify({ pair_id, side, proof_b64, public_inputs_b64 }),
    }),
  getWalletBackup: (backupId: string) =>
    req<WalletBackupEnvelope>(`/wallet-backups/${encodeURIComponent(backupId)}`),
  putWalletBackup: (
    backupId: string,
    body: WalletBackupEnvelope & { expected_generation: number; write_token: string },
  ) =>
    req<{ generation: number }>(`/wallet-backups/${encodeURIComponent(backupId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
}

export interface WalletBackupEnvelope {
  format_version: 1
  generation: number
  nonce_b64: string
  ciphertext_b64: string
}

export interface NoteProof {
  leaf_index: number
  root: string
  siblings: string[]
  index_bits: number[]
}

export interface ChainNote {
  leaf_index: number
  asset: number
  amount: string
  owner_tag: string
}

/** A crossing-fill summary from a `filled` event (taker-perspective: `in` spent, `out` received). */
export interface Fill {
  id: string
  ledger: number
  tx_hash: string
  asset_in: number
  amount_in: string
  asset_out: number
  amount_out: string
  owner_tag: string
}
