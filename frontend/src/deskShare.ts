import type { Desk } from './api'

const FORMAT = 'MOSAIC-DESK-V1'
const HEADER = '-----BEGIN MOSAIC DESK-----'
const FOOTER = '-----END MOSAIC DESK-----'
const CHECKSUM_HEX = 12

type DeskSharePayload = {
  version: 1
  network_passphrase: string
  id: string
  name: string
  contract_id: string
  sponsor_pubkey: string
  event_start_ledger: number | null
  assets: Desk['assets']
  pairs: Desk['pairs']
  base_deployment: Desk['base_deployment']
}

export class DeskShareError extends Error {}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new DeskShareError('Desk share payload is not valid base64url.')
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function wrapToken(token: string): string {
  const lines = token.match(/.{1,76}/g) ?? [token]
  return `${HEADER}\n${lines.join('\n')}\n${FOOTER}`
}

function normalizeToken(input: string): string {
  let text = input.trim()
  if (text.includes(HEADER) || text.includes(FOOTER)) {
    const start = text.indexOf(HEADER)
    const end = text.indexOf(FOOTER)
    if (start < 0 || end < 0 || end <= start) throw new DeskShareError('Desk share block is incomplete.')
    text = text.slice(start + HEADER.length, end)
  }
  return text.replace(/\s+/g, '')
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new DeskShareError(`Desk share is missing ${label}.`)
  return value
}

function assertNullableLedger(value: unknown): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DeskShareError('Desk share has an invalid event_start_ledger.')
  }
  return value as number
}

function assertAssetKind(value: unknown): Desk['assets'][number]['kind'] {
  if (value === 'Stellar' || value === 'Dual' || value === 'BaseRepresented') return value
  throw new DeskShareError('Desk share has an invalid asset kind.')
}

function assertAsset(value: unknown): Desk['assets'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeskShareError('Desk share has an invalid asset.')
  }
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.asset_id) || (record.asset_id as number) < 0) {
    throw new DeskShareError('Desk share has an invalid asset id.')
  }
  if (!Number.isSafeInteger(record.decimals) || (record.decimals as number) < 0) {
    throw new DeskShareError('Desk share has an invalid asset decimals value.')
  }
  const token = record.token
  if (token !== null && typeof token !== 'string') throw new DeskShareError('Desk share has an invalid asset token.')
  return {
    asset_id: record.asset_id as number,
    symbol: assertString(record.symbol, 'asset symbol').trim().toUpperCase(),
    token,
    decimals: record.decimals as number,
    kind: assertAssetKind(record.kind),
  }
}

function assertPair(value: unknown): Desk['pairs'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeskShareError('Desk share has an invalid pair.')
  }
  const record = value as Record<string, unknown>
  for (const field of ['pair_id', 'base_asset', 'quote_asset'] as const) {
    if (!Number.isSafeInteger(record[field]) || (record[field] as number) < 0) {
      throw new DeskShareError(`Desk share has an invalid ${field}.`)
    }
  }
  return {
    pair_id: record.pair_id as number,
    base_asset: record.base_asset as number,
    quote_asset: record.quote_asset as number,
  }
}

function decodePayload(value: unknown): DeskSharePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeskShareError('Desk share payload is not an object.')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1) throw new DeskShareError('Unsupported desk share version.')
  if (!Array.isArray(record.assets) || record.assets.length === 0) {
    throw new DeskShareError('Desk share must include at least one asset.')
  }
  if (!Array.isArray(record.pairs)) throw new DeskShareError('Desk share pairs must be an array.')
  return {
    version: 1,
    network_passphrase: assertString(record.network_passphrase, 'network passphrase'),
    id: assertString(record.id, 'desk id'),
    name: assertString(record.name, 'desk name'),
    contract_id: assertString(record.contract_id, 'contract id'),
    sponsor_pubkey: assertString(record.sponsor_pubkey, 'sponsor public key'),
    event_start_ledger: assertNullableLedger(record.event_start_ledger),
    assets: record.assets.map(assertAsset),
    pairs: record.pairs.map(assertPair),
    base_deployment: (record.base_deployment ?? null) as Desk['base_deployment'],
  }
}

export async function encodeDeskShare(desk: Desk, networkPassphrase: string): Promise<string> {
  const payload: DeskSharePayload = {
    version: 1,
    network_passphrase: networkPassphrase,
    id: desk.id,
    name: desk.name,
    contract_id: desk.contract_id,
    sponsor_pubkey: desk.sponsor_pubkey,
    event_start_ledger: desk.event_start_ledger,
    assets: desk.assets,
    pairs: desk.pairs,
    base_deployment: desk.base_deployment,
  }
  const json = JSON.stringify(payload)
  const body = bytesToBase64Url(new TextEncoder().encode(json))
  const checksum = (await sha256Hex(`${FORMAT}.${body}`)).slice(0, CHECKSUM_HEX)
  return wrapToken(`${FORMAT}.${body}.${checksum}`)
}

export async function parseDeskShare(input: string): Promise<{ desk: Desk; networkPassphrase: string }> {
  const token = normalizeToken(input)
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== FORMAT) throw new DeskShareError('Desk share has an unsupported format.')
  const [, body, checksum] = parts
  if (!/^[0-9a-f]{12}$/i.test(checksum)) throw new DeskShareError('Desk share checksum is malformed.')
  const expected = (await sha256Hex(`${FORMAT}.${body}`)).slice(0, CHECKSUM_HEX)
  if (checksum.toLowerCase() !== expected) throw new DeskShareError('Desk share checksum does not match.')
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body)))
  } catch {
    throw new DeskShareError('Desk share payload cannot be decoded.')
  }
  const payload = decodePayload(raw)
  return {
    networkPassphrase: payload.network_passphrase,
    desk: {
      id: payload.id,
      name: payload.name,
      contract_id: payload.contract_id,
      sponsor_pubkey: payload.sponsor_pubkey,
      event_start_ledger: payload.event_start_ledger,
      assets: payload.assets,
      pairs: payload.pairs,
      base_deployment: payload.base_deployment,
    },
  }
}
