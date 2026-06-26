import { Noir } from '@noir-lang/noir_js'
import { BASE_FEE, Contract, Networks, rpc, scValToNative, TransactionBuilder } from '@stellar/stellar-sdk'
import {
  ChainEventSource,
  errorMessage,
  LocalPathProvider,
  makeNoirCompressor,
  replayNoteEvents,
  type AssetDef,
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
import { browserActivityStore, browserEventCache, getLocalDesk, IndexedDbStore, listLocalDesks, putLocalDesk } from './sdk/indexedDbStore'
import { currentAddress } from './wallet'
import { defaultCatalogAssets } from './defaultCatalog'
import { initNoirWasm } from './noirWasm'
import { MCP_URL, SOROBAN_RPC_URL } from './config'

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
const deskCache = new Map<string, Desk>()
const chain = new ChainEventSource({
  network: { rpcUrl: SOROBAN_RPC_URL, networkPassphrase: Networks.TESTNET },
  startLedger: 0,
  cache: browserEventCache,
  activity: browserActivityStore,
})

let compressNoir: Noir | undefined
const compress = makeNoirCompressor({
  execute: async (inputs) => {
    await initNoirWasm()
    compressNoir ??= new Noir(await circuitProvider('compress'))
    return compressNoir.execute(inputs as never)
  },
})
const source = new LocalPathProvider({
  compress,
  events: async (deskId) => {
    const desk = await getDesk(deskId)
    return chain.events(desk.contract_id, desk.event_start_ledger ?? 0, {
      validateReplay: (events) => validateReplayRoot(desk, events),
    })
  },
  fills: async (deskId) => {
    const desk = await getDesk(deskId)
    return chain.fills(desk.contract_id, desk.event_start_ledger ?? 0, {
      validateReplay: (events) => validateReplayRoot(desk, events),
    })
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

async function getDesk(id: string): Promise<Desk> {
  const cached = deskCache.get(id)
  if (cached) return cached
  const local = await getLocalDesk(id)
  if (local) {
    const desk = local as Desk
    deskCache.set(id, desk)
    return desk
  }
  const desk = (await mcp.getDesk(id)) as Desk
  deskCache.set(id, desk)
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

function mergeDesks(remote: Desk[], local: Desk[]): Desk[] {
  const byId = new Map<string, Desk>()
  for (const desk of remote) byId.set(desk.id, desk)
  for (const desk of local) byId.set(desk.id, desk)
  return [...byId.values()]
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
  listDesks: (includeRemote = false) => wrap(async () => mergeDesks(
    includeRemote ? await mcp.listDesks().catch(() => [] as Desk[]) : [],
    (await listLocalDesks()) as Desk[],
  )),
  getDesk: (id: string) => wrap(() => getDesk(id)),
  getRoot: (id: string) => wrap(async () => ({ root: await readContractRoot(await getDesk(id)) })),
  importDesk: (body: {
    name: string
    contract_id: string
    sponsor_pubkey: string
    assets: Asset[]
    pairs: Pair[]
  }) => wrap(async () => {
    const desk = (await mcp.importDesk(body)) as Desk
    deskCache.set(desk.id, desk)
    return desk
  }),
  createDesk: (body: {
    name: string
    assets: { catalog_id: string; asset_id: number; symbol: string; token: string; decimals: number; kind: AssetKind }[]
    pairs: { base_asset: number; quote_asset: number }[]
    base_deployment?: { deployer_address: string }
  }) => wrap(async () => {
    const desk = (await mcp.createDesk(body)) as Desk
    deskCache.set(desk.id, desk)
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
      store: new IndexedDbStore(),
      activity: browserActivityStore,
      initNoir: initNoirWasm,
      eventCache: browserEventCache,
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
    await putLocalDesk(desk)
    deskCache.set(desk.id, desk)
    return desk
  }),
  getBaseDeploymentConfig: () => wrap(async () => (await mcp.baseDeploymentConfig()) as BaseDeploymentConfig),
  completeBaseDeployment: (id: string, body: { tx_hash: string; bridge_address: string }) =>
    wrap(async () => {
      const desk = (await mcp.completeBaseDeployment(id, body)) as Desk
      deskCache.set(desk.id, desk)
      return desk
    }),
  listCatalogAssets: (includeRemote = false) =>
    wrap(() => includeRemote ? mcp.listAssets() : Promise.resolve(defaultCatalogAssets())),
  proposeAsset: (body: ProposeAssetBody) => wrap(() => mcp.proposeAsset(body)),
  trustAsset: (id: string) => wrap(() => mcp.trustAsset(id)),
  untrustAsset: (id: string) => wrap(() => mcp.untrustAsset(id)),
  getNotes: (id: string) => wrap(async () => ({ notes: await source.notes(id) })),
  getFills: (id: string) => wrap(async () => ({ fills: await source.fills(id) })),
  getBaseShieldConfig: (id: string) => wrap(() => mcp.baseShieldConfig(id)),
  enqueueBaseShield: (id: string, body: { expected_bridge: string; deposit_id: number }) =>
    wrap(() => mcp.enqueueBaseShield(id, body)),
  listBaseShields: (id: string) => wrap(() => mcp.listBaseShields(id)),
  submitShield: (id: string, tx_xdr: string) =>
    wrap(async () => {
      const result = await mcp.relayShield(id, tx_xdr, lease())
      return { ok: true, result: result.txHash }
    }),
  getNoteProof: (id: string, ownerTag: string) => wrap(() => source.notePath(id, ownerTag)),
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
}
