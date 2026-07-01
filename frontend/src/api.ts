import { Noir } from '@noir-lang/noir_js'
import { BASE_FEE, Contract, Networks, rpc, scValToNative, TransactionBuilder } from '@stellar/stellar-sdk'
import {
  ChainEventSource,
  errorMessage,
  LocalPathProvider,
  makeNoirCompressor,
  replayNoteEvents,
  type AssetDef,
  type ActivityEvent,
  type AuthChallenge,
  type AuthSession,
  type BaseDeploymentConfig as SdkBaseDeploymentConfig,
  type BaseShieldConfig,
  type BaseShieldJob,
  type CatalogAsset as SdkCatalogAsset,
  type ChainNote,
  type ClientAction,
  type Desk as SdkDesk,
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
import { circuitProvider } from '@mosaic/sdk/assets/browser'
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
import { initNoirWasm } from './noirWasm'
import { MCP_URL, SOROBAN_RPC_URL } from './config'
import type { StorageMode } from './StorageModeContext'

export type AssetKind = 'Stellar' | 'Dual' | 'BaseRepresented'
export type Asset = AssetDef & { token: string | null }
export type Pair = PairDef
export type CatalogAsset = SdkCatalogAsset
export type ProposeAssetBody = SdkProposeAssetBody
export type Desk = Omit<SdkDesk, 'assets'> & { assets: Asset[] }
export type BaseAssetMapping = { asset_id: number; symbol: string; token: string }
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
  if (mode === 'trustless') {
    const local = await getLocalDesk(mode, id)
    if (!local) throw new ApiError(404, `desk ${id} not found in trustless mode`)
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

async function validateReplayRoot(desk: Desk, events: TreeEvent[]): Promise<void> {
  const [state, root] = await Promise.all([
    replayNoteEvents({ events, compress }),
    readContractRoot(desk),
  ])
  if (state.root.toLowerCase() !== root.toLowerCase()) {
    throw new Error('retained event replay root does not match the live contract root')
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
  importDesk: (body: {
    name: string
    contract_id: string
    sponsor_pubkey: string
    assets: Asset[]
    pairs: Pair[]
  }) => wrap(async () => {
    const desk = (await mcp.importDesk(body)) as Desk
    deskCache('trusted').set(desk.id, desk)
    return desk
  }),
  createDesk: (body: {
    name: string
    assets: { catalog_id: string; asset_id: number; symbol: string; token: string; decimals: number; kind: AssetKind }[]
    pairs: { base_asset: number; quote_asset: number }[]
    base_deployment?: { deployer_address: string }
  }) => wrap(async () => {
    const desk = (await mcp.createDesk(body)) as Desk
    deskCache('trusted').set(desk.id, desk)
    return desk
  }),
  createDeskSelfFunded: (body: {
    name: string
    assets: { catalog_id: string; asset_id: number; symbol: string; token: string; decimals: number; kind: AssetKind }[]
    pairs: { base_asset: number; quote_asset: number }[]
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
      // No persistent eventCache: this one-shot deploy client must not seed the long-lived reconcile
      // source's cache scope with a cursor (which would later resume reads past freshly-shielded notes).
    })
    const startLedger = (await new rpc.Server(SOROBAN_RPC_URL).getLatestLedger()).sequence
    const deployed = await client.deploy({
      name: body.name,
      assets: body.assets.map((asset) => ({
        asset_id: asset.asset_id,
        symbol: asset.symbol,
        token: asset.kind === 'BaseRepresented' ? null : asset.token,
        decimals: asset.decimals,
        kind: asset.kind,
      })),
      pairs: body.pairs,
    })
    const desk = {
      id: deployed.id,
      name: deployed.name ?? body.name,
      contract_id: deployed.contractId,
      sponsor_pubkey: address,
      assets: deployed.assets,
      pairs: deployed.pairs,
      event_start_ledger: startLedger,
      base_deployment: null,
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
  getBook: (id: string, pair: number, side: number) => wrap(() => mcp.getBook(id, pair, side)),
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
  enqueueBaseShield: (id: string, body: { expected_bridge: string; deposit_id: number }) =>
    wrap(() => mcp.enqueueBaseShield(id, body)),
  listBaseShields: (id: string) => wrap(() => mcp.listBaseShields(id)),
  submitShield: (id: string, tx_xdr: string) =>
    wrap(async () => {
      const result = await mcp.relayShield(id, tx_xdr, lease())
      return { ok: true, result: result.txHash }
    }),
  getNoteProof: (mode: StorageMode, id: string, ownerTag: string) => wrap(() => sourceFor(mode).notePath(id, ownerTag)),
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
