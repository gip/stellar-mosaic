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

/** An entry in the app-wide asset catalog: a cross-chain definition (Stellar side always present,
 * Base side optional). Off-chain metadata only — on-chain support is set at contract deployment. */
export interface CatalogAsset {
  id: string
  symbol: string
  stellar_token: string | null
  stellar_decimals: number | null
  base_chain_id: number | null
  base_token: string | null
  base_decimals: number | null
  proposer_address: string | null
  is_default: boolean
  created_at: number
  trust_count: number
  trusted_by_me: boolean
}

export interface ProposeAssetBody {
  symbol: string
  stellar_token?: string | null
  stellar_decimals?: number | null
  base_chain_id?: number | null
  base_token?: string | null
  base_decimals?: number | null
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

/** One resting order from the event-derived book (`GET /desks/:id/book`). */
export interface BookOrder {
  leaf_index: number
  order_leaf: string
  asset_in: number
  amount_in: string
  asset_out: number
  min_out: string
  output_owner_tag: string
  cancel_owner_tag: string
  expiry: number
  partial_allowed: boolean
  active: boolean
}

/** Order-tree membership path for an order_leaf (`GET /desks/:id/order-proof`). */
export interface OrderProof {
  leaf_index: number
  order_root: string
  siblings: string[]
  index_bits: number[]
  consumption_nullifier: string
}

/** The nullifier-IMT insert witness for a value (`GET /desks/:id/imt-witness`). The exact private
 * inputs a WS4 spend circuit's imt_insert needs, plus the root transition. */
export interface ImtWitnessResp {
  nullifier_root_in: string
  nullifier_root_out: string
  low_value: string
  low_next_value: string
  low_next_index: number
  low_path: string[]
  low_index_bits: number[]
  new_path: string[]
  new_index_bits: number[]
}

export const api = {
  listDesks: () => req<Desk[]>('/desks'),
  getDesk: (id: string) => req<Desk>(`/desks/${id}`),
  getRoot: (id: string) => req<{ root: string }>(`/desks/${id}/root`),
  // WS4: the event-derived active book (all resting orders, each with its full public terms +
  // active flag). The client filters by asset locally; no pair/side query needed.
  getBook: (id: string) => req<{ orders: BookOrder[] }>(`/desks/${id}/book`),
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
  listCatalogAssets: () => req<CatalogAsset[]>('/assets'),
  proposeAsset: (body: ProposeAssetBody) =>
    req<CatalogAsset>('/assets', { method: 'POST', body: JSON.stringify(body) }),
  trustAsset: (id: string) =>
    req<{ ok: boolean }>(`/assets/${id}/trust`, { method: 'POST' }),
  untrustAsset: (id: string) =>
    req<{ ok: boolean }>(`/assets/${id}/trust`, { method: 'DELETE' }),
  getNotes: (id: string) => req<{ notes: ChainNote[] }>(`/desks/${id}/notes`),
  getFills: (id: string) => req<{ fills: Fill[] }>(`/desks/${id}/fills`),
  enqueueBaseShield: (id: string, body: { bridge: string; deposit_id: number }) =>
    req<BaseShieldJob>(`/desks/${id}/base-shields`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listBaseShields: (id: string) => req<BaseShieldJob[]>(`/desks/${id}/base-shields`),
  submitShield: (id: string, tx_xdr: string) =>
    req<{ ok: boolean; result: string }>(`/client-actions/relay/desks/${id}/shield`, {
      method: 'POST',
      body: JSON.stringify({ tx_xdr }),
    }),
  getNoteProof: (id: string, ownerTag: string) =>
    req<NoteProof>(`/desks/${id}/note-proof?owner_tag=${ownerTag}`),
  // WS4 proving inputs: order-tree path (for match/cancel) + the nullifier-IMT insert witness.
  getOrderProof: (id: string, orderLeaf: string) =>
    req<OrderProof>(`/desks/${id}/order-proof?order_leaf=${orderLeaf}`),
  getImtWitness: (id: string, value: string) =>
    req<ImtWitnessResp>(`/desks/${id}/imt-witness?value=${value}`),
  relayMatch: (id: string, proof_b64: string, public_inputs_b64: string) =>
    req<{ ok: boolean; result: string }>(`/client-actions/relay/desks/${id}/match`, {
      method: 'POST',
      body: JSON.stringify({ proof_b64, public_inputs_b64 }),
    }),
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

export interface BaseShieldJob {
  id: string
  desk_id: string
  bridge: string
  deposit_id: number
  status: string
  block_number?: number | null
  block_hash?: string | null
  error?: string | null
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
