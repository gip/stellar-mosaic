import { Noir } from '@noir-lang/noir_js'
import { Asset as StellarAsset, BASE_FEE, Contract, Networks, nativeToScVal, rpc, scValToNative, TransactionBuilder } from '@stellar/stellar-sdk'
import {
  BASE_SEPOLIA_CONFIG_ID,
  ChainEventSource,
  DeployDeskError,
  errorMessage,
  LocalPathProvider,
  makeNoirCompressor,
  readDeskCustody,
  replayNoteEvents,
  type AssetDef,
  type ActivityEvent,
  type AuthChallenge,
  type AuthSession,
  type BaseDeploymentConfig as SdkBaseDeploymentConfig,
  type BaseShieldConfig,
  type BaseShieldDeposit,
  type BaseShieldJob,
  type CatalogAsset as SdkCatalogAsset,
  type ChainNote,
  type ClientAction,
  type Desk as SdkDesk,
  type DeskCustody,
  type Fill,
  type NoteProof,
  type Operation,
  type OperationRequest,
  type PairDef,
  type ProposeAssetBody as SdkProposeAssetBody,
  type TreeEvent,
  type WalletBackupEnvelope,
} from '@mosaic/sdk'
import { createBrowserClient } from '@mosaic/sdk/browser'
import { circuitProvider, loadProtocolRelease } from '@mosaic/sdk/assets/browser'
import { createMcpClient } from '@mosaic/sdk/mcp-client'
import type { Abi, Hex } from 'viem'
import { FreighterSigner } from './sdk/freighterSigner'
import {
  browserActivityStore,
  browserEventCache,
  getLocalCatalogAsset,
  getLocalDesk,
  IndexedDbStore,
  listLocalCatalogAssets,
  listLocalDesks,
  putLocalCatalogAsset,
  putLocalDesk,
} from './sdk/indexedDbStore'
import { currentAddress } from './wallet'
import { defaultCatalogAssets, mergeCatalogAssets } from './defaultCatalog'
import { parseDeskShare } from './deskShare'
import { initNoirWasm } from './noirWasm'
import { BASE_ROUTER_ID, BASE_RPC_URL, MCP_URL, SOROBAN_RPC_URL } from './config'
import type { StorageMode } from './StorageModeContext'
import { ethereumProvider } from './base'

export type AssetKind = 'Stellar' | 'Dual' | 'BaseRepresented'
export type Asset = AssetDef & { token: string | null }
export type Pair = PairDef
export type CatalogAsset = SdkCatalogAsset
export type ProposeAssetBody = SdkProposeAssetBody
export type Desk = Omit<SdkDesk, 'assets'> & { assets: Asset[] }
export type BaseAssetMapping = { asset_id: number; symbol: string; token: string }
export type { DeskCustody }
export type BaseDeployment = NonNullable<SdkDesk['base_deployment']>
export type BaseDeploymentConfig = Omit<SdkBaseDeploymentConfig, 'abi' | 'bytecode'> & {
  abi: Abi | null
  bytecode: Hex | null
}
export type { AuthChallenge, AuthSession, BaseShieldConfig, BaseShieldJob, ChainNote, ClientAction, Fill, NoteProof, Operation, OperationRequest, WalletBackupEnvelope }

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const mcp = createMcpClient({ url: MCP_URL })
const deskCaches = new Map<StorageMode, Map<string, Desk>>()
const sources = new Map<StorageMode, LocalPathProvider>()
const CONTRACT_ID = /^C[A-Z2-7]{55}$/

let compressNoir: Noir | undefined
const compress = makeNoirCompressor({
  execute: async (inputs) => {
    await initNoirWasm()
    compressNoir ??= new Noir(await circuitProvider('compress'))
    return compressNoir.execute(inputs as never)
  },
})
let activeClientAction: ClientAction | null = null

function lease() {
  return activeClientAction
    ? { action_id: activeClientAction.id, lease_token: activeClientAction.lease_token }
    : undefined
}

async function wrap<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(500, errorMessage(error))
  }
}

function deskCache(mode: StorageMode): Map<string, Desk> {
  let cache = deskCaches.get(mode)
  if (!cache) {
    cache = new Map()
    deskCaches.set(mode, cache)
  }
  return cache
}

function sourceFor(mode: StorageMode): LocalPathProvider {
  const cached = sources.get(mode)
  if (cached) return cached
  const chain = new ChainEventSource({
    network: { rpcUrl: SOROBAN_RPC_URL, networkPassphrase: Networks.TESTNET },
    startLedger: 0,
    cache: browserEventCache(mode),
    activity: browserActivityStore(mode),
  })
  const source = new LocalPathProvider({
    compress,
    events: async (deskId) => {
      const desk = await getDesk(mode, deskId)
      return chain.events(desk.contract_id, desk.event_start_ledger ?? 0, {
        validateReplay: (events) => validateReplayRoot(desk, events),
      })
    },
    fills: async (deskId) => {
      const desk = await getDesk(mode, deskId)
      return chain.fills(desk.contract_id, desk.event_start_ledger ?? 0, {
        validateReplay: (events) => validateReplayRoot(desk, events),
      })
    },
  })
  sources.set(mode, source)
  return source
}

export function resetApiCaches(): void {
  deskCaches.clear()
  sources.clear()
}

async function getDesk(mode: StorageMode, id: string): Promise<Desk> {
  const cache = deskCache(mode)
  const cached = cache.get(id)
  if (cached) return cached
  // Anything that is not explicitly trusted stays browser-local — agent mode must never reach the
  // Mosaic Server.
  if (mode !== 'trusted') {
    const local = await getLocalDesk(mode, id)
    if (!local) throw new ApiError(404, `desk ${id} not found in ${mode} mode`)
    const desk = local as Desk
    cache.set(id, desk)
    return desk
  }
  const desk = (await mcp.getDesk(id)) as Desk
  cache.set(id, desk)
  return desk
}

function bytesToHex(value: unknown): string {
  const bytes =
    value instanceof Uint8Array ? value : ArrayBuffer.isView(value) ? new Uint8Array((value as ArrayBufferView).buffer) : null
  if (!bytes) throw new Error('contract returned non-bytes root')
  return `0x${Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('')}`
}

async function readContractRoot(desk: Desk): Promise<string> {
  const server = new rpc.Server(SOROBAN_RPC_URL)
  const account = await server.getAccount(desk.sponsor_pubkey)
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(desk.contract_id).call('root'))
    .setTimeout(30)
    .build()
  const simulation = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(simulation) || !simulation.result) {
    throw new Error('root simulation failed')
  }
  return bytesToHex(scValToNative(simulation.result.retval))
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value instanceof Map) return Object.fromEntries(value.entries()) as Record<string, unknown>
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  throw new Error(`invalid ${label}`)
}

function kindFromNative(value: unknown): AssetKind {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text.includes('BaseRepresented')) return 'BaseRepresented'
  if (text.includes('Dual')) return 'Dual'
  if (text.includes('Stellar')) return 'Stellar'
  throw new Error('invalid asset kind from contract')
}

function normalizeAddress(value: string | null | undefined): string | null {
  return value ? value.toLowerCase() : null
}

function resolveStellarToken(token: string | null, networkPassphrase: string): string | null {
  if (token === null) return null
  if (CONTRACT_ID.test(token)) return token
  if (token === 'native') return StellarAsset.native().contractId(networkPassphrase)
  const [code, issuer] = token.split(':')
  if (code && issuer) return new StellarAsset(code, issuer).contractId(networkPassphrase)
  return token
}

async function simulateContractView(
  server: rpc.Server,
  desk: Desk,
  networkPassphrase: string,
  method: string,
  args: ReturnType<typeof nativeToScVal>[] = [],
): Promise<unknown> {
  const account = await server.getAccount(desk.sponsor_pubkey)
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(new Contract(desk.contract_id).call(method, ...args))
    .setTimeout(30)
    .build()
  const simulation = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(simulation) || !simulation.result) {
    throw new Error(`${method} simulation failed${rpc.Api.isSimulationError(simulation) ? `: ${errorMessage(simulation.error)}` : ''}`)
  }
  return scValToNative(simulation.result.retval)
}

async function verifyImportedAsset(
  server: rpc.Server,
  desk: Desk,
  networkPassphrase: string,
  asset: Asset,
): Promise<void> {
  const native = await simulateContractView(
    server,
    desk,
    networkPassphrase,
    'asset',
    [nativeToScVal(asset.asset_id, { type: 'u32' })],
  )
  if (native === null || native === undefined) throw new Error(`asset ${asset.asset_id} is not registered on-chain`)
  const live = record(native, `asset ${asset.asset_id}`)
  const kind = kindFromNative(live.kind)
  if (kind !== asset.kind) throw new Error(`asset ${asset.asset_id} kind does not match the contract`)
  const liveToken = typeof live.token === 'string' ? live.token : null
  const expectedToken = kind === 'BaseRepresented' ? null : resolveStellarToken(asset.token, networkPassphrase)
  if (normalizeAddress(liveToken) !== normalizeAddress(expectedToken)) {
    throw new Error(`asset ${asset.asset_id} token does not match the contract`)
  }
}

/** Effective shield/unshield permission for `address` on this desk (`is_allowed` view: always true
 * on an open desk). Cached per (desk, address) — membership is add-only, so a stale `false` after
 * the owner adds the wallet only lasts until `TTL_MS` and a `true` can never become wrong. */
const allowedCache = new Map<string, { value: boolean; at: number }>()
const ALLOWED_TTL_MS = 30_000

async function isAllowedOnDesk(desk: Desk, address: string): Promise<boolean> {
  if (desk.permissioned !== true) return true
  const key = `${desk.contract_id}:${address}`
  const cached = allowedCache.get(key)
  if (cached && (cached.value || Date.now() - cached.at < ALLOWED_TTL_MS)) return cached.value
  const server = new rpc.Server(SOROBAN_RPC_URL)
  const value = await simulateContractView(server, desk, Networks.TESTNET, 'is_allowed', [
    nativeToScVal(address, { type: 'address' }),
  ])
  const allowed = value === true
  allowedCache.set(key, { value: allowed, at: Date.now() })
  return allowed
}

async function verifyImportedDesk(desk: Desk, networkPassphrase: string): Promise<void> {
  if (networkPassphrase !== Networks.TESTNET) {
    throw new Error('Desk share is for a different Stellar network.')
  }
  const server = new rpc.Server(SOROBAN_RPC_URL)
  await simulateContractView(server, desk, networkPassphrase, 'root')
  // Two-sided cross-check so a share can neither hide a desk's permissioning (imports as open,
  // user hits NotAllowed later) nor claim it falsely. Pre-permissioning contracts have no
  // `permissioned` view — a failed simulation means an old (inherently open) desk.
  const livePermissioned = await simulateContractView(server, desk, networkPassphrase, 'permissioned').catch(() => false)
  if ((livePermissioned === true) !== (desk.permissioned === true)) {
    throw new Error('desk permissioned flag does not match the contract')
  }
  const pairCount = await simulateContractView(server, desk, networkPassphrase, 'pair_count')
  if (typeof pairCount !== 'number' && typeof pairCount !== 'bigint') throw new Error('pair_count simulation returned an invalid value')
  if (Number(pairCount) !== desk.pairs.length) throw new Error('desk pair count does not match the contract')
  for (const asset of desk.assets) await verifyImportedAsset(server, desk, networkPassphrase, asset)

  const startLedger = desk.event_start_ledger ?? 0
  const chain = new ChainEventSource({
    network: { rpcUrl: SOROBAN_RPC_URL, networkPassphrase },
    startLedger,
  })
  const events = await chain.events(desk.contract_id, startLedger, {
    validateReplay: (recovered) => validateReplayRoot(desk, recovered),
  })
  await validateReplayRoot(desk, events)
}

async function validateReplayRoot(desk: Desk, events: TreeEvent[]): Promise<void> {
  const [state, root] = await Promise.all([
    replayNoteEvents({ events, compress }),
    readContractRoot(desk),
  ])
  if (state.root.toLowerCase() !== root.toLowerCase()) {
    throw new Error('retained event replay root does not match the live contract root')
  }
}

/** `validateReplayRoot` only runs when `ChainEventSource` hits a ledger-range recovery — the
 * ordinary incremental read path never cross-checks its replayed root against the chain. A local
 * cache that's silently out of sync (stuck cursor, missed page, etc.) would otherwise sail through
 * this check and only surface as an on-chain `UnknownRoot` after a full UltraHonk prove. Call this
 * right before a membership witness is used, so staleness fails fast and cheaply instead. The
 * mismatch is rare enough in practice that we log the actual values (event count, both roots)
 * rather than just "it didn't match" — that's the difference between reproducing this and guessing. */
async function assertRootIsLive(mode: StorageMode, desk: Desk, replayedRoot: string): Promise<void> {
  const [liveRoot, events] = await Promise.all([readContractRoot(desk), sourceFor(mode).events(desk.id)])
  if (replayedRoot.toLowerCase() !== liveRoot.toLowerCase()) {
    console.error('[mosaic] note-proof root mismatch', {
      desk_id: desk.id,
      contract_id: desk.contract_id,
      mode,
      local_event_count: events.length,
      replayed_root: replayedRoot,
      live_contract_root: liveRoot,
    })
    throw new Error(
      `Local note index is out of sync with the desk (replayed root ${replayedRoot} does not match the live contract root ${liveRoot} after replaying ${events.length} local event(s)). Refresh the page and try again.`,
    )
  }
}

async function localCatalog(mode: StorageMode): Promise<CatalogAsset[]> {
  return mergeCatalogAssets(await listLocalCatalogAssets(mode) as CatalogAsset[])
}

async function putTrustlessCatalogAsset(asset: CatalogAsset): Promise<CatalogAsset> {
  await putLocalCatalogAsset('trustless', asset)
  return asset
}

function catalogAssetFromProposal(body: ProposeAssetBody): CatalogAsset {
  return {
    id: crypto.randomUUID(),
    symbol: body.symbol.trim().toUpperCase(),
    stellar_token: body.stellar_token ?? null,
    stellar_decimals: body.stellar_decimals ?? null,
    base_chain_id: body.base_chain_id ?? null,
    base_token: body.base_token ?? null,
    base_decimals: body.base_decimals ?? null,
    proposer_address: null,
    is_default: false,
    created_at: Date.now(),
    trust_count: 0,
    trusted_by_me: true,
  } as CatalogAsset
}

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
  mcp: () => mcp,
  listDesks: (mode: StorageMode) => wrap(async () =>
    mode === 'trusted' ? (await mcp.listDesks()) as Desk[] : (await listLocalDesks(mode)) as Desk[],
  ),
  getDesk: (mode: StorageMode, id: string) => wrap(() => getDesk(mode, id)),
  getRoot: (mode: StorageMode, id: string) => wrap(async () => ({ root: await readContractRoot(await getDesk(mode, id)) })),
  /** May `address` shield / receive an unshield on this desk? Always true on open desks. */
  isAllowed: (mode: StorageMode, id: string, address: string) =>
    wrap(async () => isAllowedOnDesk(await getDesk(mode, id), address)),
  /** Trusted mode: ask the server (which holds the desk admin + bridge owner keys) to add members
   * to a permissioned desk's allowlists. Creator-only; add-only. */
  addDeskAllowed: (deskId: string, body: { stellar_members?: string[]; evm_members?: string[] }) =>
    wrap(() => mcp.addDeskAllowed!(deskId, body)),
  importDeskShare: (share: string) => wrap(async () => {
    const { desk, networkPassphrase } = await parseDeskShare(share)
    await verifyImportedDesk(desk, networkPassphrase)
    await putLocalDesk('trustless', desk)
    deskCache('trustless').set(desk.id, desk)
    return desk
  }),
  createDesk: (body: {
    name: string
    assets: { catalog_id: string; asset_id: number; symbol: string; token: string; decimals: number; kind: AssetKind }[]
    pairs: { base_asset: number; quote_asset: number }[]
    base_assets?: { asset_id: number; symbol: string; token: string }[]
    require_finality?: boolean
    permissioned?: boolean
    allowlist?: string[]
    base_allowlist?: string[]
    /** Seed the creator on the allowlist (server-side, from the session address). Default true. */
    include_creator?: boolean
  }) => wrap(async () => {
    const desk = (await mcp.createDesk(body)) as Desk
    deskCache('trusted').set(desk.id, desk)
    return desk
  }),
  createDeskSelfFunded: (body: {
    name: string
    assets: { catalog_id: string; asset_id: number; symbol: string; token: string; decimals: number; kind: AssetKind }[]
    pairs: { base_asset: number; quote_asset: number }[]
    base_assets?: { asset_id: number; symbol: string; token: string }[]
    require_finality?: boolean
    permissioned?: boolean
    allowlist?: string[]
    base_allowlist?: string[]
    /** Accepted for symmetry with `createDesk`; the form already seeds the creator client-side
     * (there is no server on this path to do it). */
    include_creator?: boolean
  }) => wrap(async () => {
    const address = await currentAddress()
    if (!address) throw new ApiError(401, 'Connect Freighter before deploying a trustless desk.')
    const signer = new FreighterSigner(address)
    const { client } = createBrowserClient({
      network: { rpcUrl: SOROBAN_RPC_URL, networkPassphrase: Networks.TESTNET },
      signer,
      store: new IndexedDbStore('trustless'),
      activity: browserActivityStore('trustless'),
      initNoir: initNoirWasm,
      ethProvider: body.base_assets?.length ? ethereumProvider() : undefined,
      // No persistent eventCache: this one-shot deploy client must not seed the long-lived reconcile
      // source's cache scope with a cursor (which would later resume reads past freshly-shielded notes).
    })
    const startLedger = (await new rpc.Server(SOROBAN_RPC_URL).getLatestLedger()).sequence
    const release = body.base_assets?.length ? await loadProtocolRelease() : null
    const deployArgs = {
      name: body.name,
      assets: body.assets.map((asset) => ({
        asset_id: asset.asset_id,
        symbol: asset.symbol,
        token: asset.kind === 'BaseRepresented' ? null : asset.token,
        decimals: asset.decimals,
        kind: asset.kind,
      })),
      pairs: body.pairs,
      permissioned: body.permissioned === true,
      allowlist: body.allowlist,
      ...(body.base_assets?.length
        ? {
            base: {
              assets: body.base_assets,
              router_id: BASE_ROUTER_ID,
              image_id: release?.bridge_image_id ?? '',
              config_id: BASE_SEPOLIA_CONFIG_ID,
              require_finality: body.require_finality === true,
              initial_allowed: body.base_allowlist,
            },
          }
        : {}),
    }
    let deployed
    try {
      deployed = await client.deploy(deployArgs)
    } catch (cause) {
      if (cause instanceof DeployDeskError && cause.partialDesk) {
        const partial = {
          id: cause.partialDesk.id,
          name: cause.partialDesk.name ?? body.name,
          contract_id: cause.partialDesk.contractId,
          sponsor_pubkey: address,
          assets: cause.partialDesk.assets,
          pairs: cause.partialDesk.pairs,
          event_start_ledger: startLedger,
          base_deployment: cause.partialDesk.baseDeployment ?? null,
          permissioned: cause.partialDesk.permissioned === true,
        } as Desk
        await putLocalDesk('trustless', partial)
        deskCache('trustless').set(partial.id, partial)
      }
      throw cause
    }
    const desk = {
      id: deployed.id,
      name: deployed.name ?? body.name,
      contract_id: deployed.contractId,
      sponsor_pubkey: address,
      assets: deployed.assets,
      pairs: deployed.pairs,
      event_start_ledger: startLedger,
      base_deployment: deployed.baseDeployment ?? null,
      permissioned: deployed.permissioned === true,
    } as Desk
    await putLocalDesk('trustless', desk)
    deskCache('trustless').set(desk.id, desk)
    return desk
  }),
  getBaseDeploymentConfig: () => wrap(async () => (await mcp.baseDeploymentConfig()) as BaseDeploymentConfig),
  completeBaseDeployment: (id: string, body: { tx_hash: string; bridge_address: string }) =>
    wrap(async () => {
      const desk = (await mcp.completeBaseDeployment(id, body)) as Desk
      deskCache('trusted').set(desk.id, desk)
      return desk
    }),
  // Trusted mode: ask the server to re-run its own Base bridge deploy for a desk whose bridge failed.
  retryBaseDeployment: (id: string) =>
    wrap(async () => {
      const desk = (await mcp.retryBaseDeployment(id)) as Desk
      deskCache('trusted').set(desk.id, desk)
      return desk
    }),
  getBook: (id: string, pair: number, side: number) => wrap(() => mcp.getBook(id, pair, side)),
  getDeskCustody: (mode: StorageMode, id: string): Promise<DeskCustody> =>
    wrap(async () => {
      if (mode === 'trusted') return mcp.getDeskCustody(id)
      const desk = await getDesk(mode, id)
      return readDeskCustody({
        desk,
        stellar: { rpcUrl: SOROBAN_RPC_URL, networkPassphrase: Networks.TESTNET },
        baseRpcUrl: BASE_RPC_URL,
      })
    }),
  listCatalogAssets: (mode: StorageMode) =>
    wrap(() => mode === 'trusted' ? mcp.listAssets() : localCatalog(mode)),
  proposeAsset: (mode: StorageMode, body: ProposeAssetBody) =>
    wrap(() => mode === 'trusted' ? mcp.proposeAsset(body) : putTrustlessCatalogAsset(catalogAssetFromProposal(body))),
  trustAsset: (mode: StorageMode, id: string) => wrap(async () => {
    if (mode === 'trusted') return mcp.trustAsset(id)
    const existing = await getLocalCatalogAsset(mode, id)
      ?? (defaultCatalogAssets() as CatalogAsset[]).find((asset) => asset.id === id)
    if (!existing) throw new ApiError(404, `asset ${id} not found in trustless mode`)
    await putLocalCatalogAsset(mode, { ...existing, trusted_by_me: true } as CatalogAsset)
    return { ok: true }
  }),
  untrustAsset: (mode: StorageMode, id: string) => wrap(async () => {
    if (mode === 'trusted') return mcp.untrustAsset(id)
    const existing = await getLocalCatalogAsset(mode, id)
      ?? (defaultCatalogAssets() as CatalogAsset[]).find((asset) => asset.id === id)
    if (!existing) throw new ApiError(404, `asset ${id} not found in trustless mode`)
    await putLocalCatalogAsset(mode, { ...existing, trusted_by_me: false } as CatalogAsset)
    return { ok: true }
  }),
  getNotes: (mode: StorageMode, id: string) => wrap(async () => ({ notes: await sourceFor(mode).notes(id) })),
  getFills: (mode: StorageMode, id: string) => wrap(async () => ({ fills: await sourceFor(mode).fills(id) })),
  getBaseShieldConfig: (id: string) => wrap(() => mcp.baseShieldConfig(id)),
  enqueueBaseShield: (id: string, body: { expected_bridge: string; deposit_id: number; deposit?: BaseShieldDeposit }) =>
    wrap(() => mcp.enqueueBaseShield(id, body)),
  listBaseShields: (id: string) => wrap(() => mcp.listBaseShields(id)),
  submitShield: (id: string, tx_xdr: string) =>
    wrap(async () => {
      const result = await mcp.relayShield(id, tx_xdr, lease())
      return { ok: true, result: result.txHash }
    }),
  getNoteProof: (mode: StorageMode, id: string, ownerTag: string) =>
    wrap(async () => {
      const [desk, membership] = await Promise.all([getDesk(mode, id), sourceFor(mode).notePath(id, ownerTag)])
      await assertRootIsLive(mode, desk, membership.root)
      return membership
    }),
  relayOrder: (id: string, proof_b64: string, public_inputs_b64: string) =>
    wrap(async () => {
      const result = await mcp.relayOrder(id, proof_b64, public_inputs_b64, lease())
      return { ok: true, result: result.txHash }
    }),
  relayJoin: (id: string, proof_b64: string, public_inputs_b64: string) =>
    wrap(async () => {
      const result = await mcp.relayJoin(id, proof_b64, public_inputs_b64, lease())
      return { ok: true, result: result.txHash }
    }),
  relayUnshield: (id: string, to: string, proof_b64: string, public_inputs_b64: string) =>
    wrap(async () => {
      const result = await mcp.relayUnshield(id, to, proof_b64, public_inputs_b64, lease())
      return { ok: true, result: result.txHash }
    }),
  relayCancel: (id: string, pair_id: number, side: number, proof_b64: string, public_inputs_b64: string) =>
    wrap(async () => {
      const result = await mcp.relayCancel(id, pair_id, side, proof_b64, public_inputs_b64, lease())
      return { ok: true, result: result.txHash }
    }),
  getWalletBackup: (backupId: string) => wrap(async () => {
    const backup = await mcp.getWalletBackup(backupId)
    if (!backup) throw new ApiError(404, 'wallet backup not found')
    return backup
  }),
  putWalletBackup: (
    backupId: string,
    body: WalletBackupEnvelope & { expected_generation: number; write_token: string },
  ) => wrap(() => mcp.putWalletBackup(backupId, body)),
  getAuthSession: () => wrap(async () => {
    const session = await mcp.session()
    if (!session) throw new ApiError(401, 'wallet session required')
    return session
  }),
  createAuthChallenge: (address: string) => {
    void address
    return Promise.reject(new ApiError(410, 'Use createMcpClient().authenticate() for MCP auth.')) as Promise<AuthChallenge>
  },
  createAuthSession: (challenge_id: string, signature: string) => {
    void challenge_id
    void signature
    return Promise.reject(new ApiError(410, 'Use createMcpClient().authenticate() for MCP auth.')) as Promise<AuthSession>
  },
  deleteAuthSession: () => wrap(async () => {
    await mcp.logout()
    return { ok: true }
  }),
  createOperation: (body: OperationRequest, idempotencyKey = crypto.randomUUID()) =>
    wrap(() => mcp.createOperation(body, idempotencyKey)),
  listOperations: () => wrap(() => mcp.listOperations()),
  getOperation: (id: string) => wrap(() => mcp.getOperation(id)),
  cancelOperation: (id: string) => wrap(() => mcp.cancelOperation(id)),
  claimClientAction: () => wrap(() => mcp.claimClientAction()),
  heartbeatClientAction: (id: string, lease_token: string) => wrap(() => mcp.heartbeatClientAction(id, lease_token)),
  completeClientAction: (id: string, lease_token: string, result: unknown) =>
    wrap(() => mcp.completeClientAction(id, lease_token, result)),
  failClientAction: (id: string, lease_token: string, error: string, retryable = false) =>
    wrap(() => mcp.failClientAction(id, lease_token, error, retryable)),
  operationEventsSince: (cursor: number) => wrap(() => mcp.operationEventsSince(cursor)),
  recordActivity: (events: ActivityEvent[]) => wrap(() => mcp.recordActivity(events)),
  activitySince: (cursor: number) => wrap(() => mcp.activitySince(cursor)),
}
