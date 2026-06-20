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
  const action = activeClientAction
  const res = await fetch(BASE + path, {
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(action
        ? { 'x-mosaic-action-id': action.id, 'x-mosaic-action-lease': action.lease_token }
        : {}),
    },
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

let activeClientAction: ClientAction | null = null

/** Mutation relays are accepted only while a leased durable client action is active. */
export async function withClientAction<T>(action: ClientAction, run: () => Promise<T>): Promise<T> {
  if (activeClientAction) throw new Error('Another private wallet action is already running.')
  activeClientAction = action
  try {
    return await run()
  } finally {
    activeClientAction = null
  }
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
    req<{ ok: boolean; result: string }>(`/client-actions/relay/desks/${id}/shield`, {
      method: 'POST',
      body: JSON.stringify({ tx_xdr }),
    }),
  getNoteProof: (id: string, ownerTag: string) =>
    req<NoteProof>(`/desks/${id}/note-proof?owner_tag=${ownerTag}`),
  relayOrder: (id: string, proof_b64: string, public_inputs_b64: string) =>
    req<{ ok: boolean; result: string }>(`/client-actions/relay/desks/${id}/order`, {
      method: 'POST',
      body: JSON.stringify({ proof_b64, public_inputs_b64 }),
    }),
  relayJoin: (id: string, proof_b64: string, public_inputs_b64: string) =>
    req<{ ok: boolean; result: string }>(`/client-actions/relay/desks/${id}/join`, {
      method: 'POST',
      body: JSON.stringify({ proof_b64, public_inputs_b64 }),
    }),
  relayUnshield: (id: string, to: string, proof_b64: string, public_inputs_b64: string) =>
    req<{ ok: boolean; result: string }>(`/client-actions/relay/desks/${id}/unshield`, {
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
    req<{ ok: boolean; result: string }>(`/client-actions/relay/desks/${id}/cancel`, {
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
  getAuthSession: () => req<AuthSession>('/auth/session'),
  createAuthChallenge: (address: string) =>
    req<AuthChallenge>('/auth/challenges', { method: 'POST', body: JSON.stringify({ address }) }),
  createAuthSession: (challenge_id: string, signature: string) =>
    req<AuthSession>('/auth/sessions', {
      method: 'POST',
      body: JSON.stringify({ challenge_id, signature }),
    }),
  deleteAuthSession: () => req<{ ok: boolean }>('/auth/sessions', { method: 'DELETE' }),
  createOperation: (body: OperationRequest, idempotencyKey = crypto.randomUUID()) =>
    req<Operation>('/operations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
    }),
  listOperations: () => req<Operation[]>('/operations'),
  getOperation: (id: string) => req<Operation>(`/operations/${id}`),
  cancelOperation: (id: string) => req<Operation>(`/operations/${id}/cancel`, { method: 'POST' }),
  claimClientAction: () =>
    req<{ action: ClientAction | null }>('/client-actions/next', { method: 'POST' }),
  heartbeatClientAction: (id: string, lease_token: string) =>
    req<{ lease_expires_at: number }>(`/client-actions/${id}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({ lease_token }),
    }),
  completeClientAction: (id: string, lease_token: string, result: unknown) =>
    req<Operation>(`/client-actions/${id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ lease_token, result }),
    }),
  failClientAction: (id: string, lease_token: string, error: string, retryable = false) =>
    req<Operation>(`/client-actions/${id}/fail`, {
      method: 'POST',
      body: JSON.stringify({ lease_token, error, retryable }),
    }),
}

export interface AuthChallenge { challenge_id: string; message: string; expires_at: number }
export interface AuthSession { address: string; network: string; expires_at?: number }

export type OperationStatus =
  | 'queued' | 'running' | 'waiting_for_client' | 'waiting_for_chain'
  | 'succeeded' | 'failed' | 'cancelled'

export interface Operation {
  id: string
  address: string
  network: string
  desk_id: string
  kind: 'shield' | 'place_order' | 'unshield' | 'cancel_order'
  request: OperationRequest
  status: OperationStatus
  created_at: number
  updated_at: number
  error?: string | null
  submitted: boolean
}

export type OperationRequest =
  | { kind: 'shield'; desk_id: string; asset_id: number; amount: string }
  | { kind: 'place_order'; desk_id: string; pair_id: number; side: 'BUY' | 'SELL'; amount_in: string; min_out: string; partial_allowed: boolean }
  | { kind: 'unshield'; desk_id: string; asset_id: number; amount: string; recipient: string }
  | { kind: 'cancel_order'; desk_id: string; wallet_note_id: string }

export interface ClientAction {
  id: string
  operation_id: string
  kind: Operation['kind']
  payload: OperationRequest
  lease_token: string
  lease_expires_at: number
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
