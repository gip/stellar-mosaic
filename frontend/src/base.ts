// Base (Sepolia) side of the shield bridge: connect an EVM wallet and call MosaicBridge.shield.
// The note's owner_tag is derived the same way as a native shield (see ShieldFromBaseForm), so the
// minted Stellar note reconciles by owner_tag and is spendable like any other.
import {
  concat,
  createPublicClient,
  createWalletClient,
  custom,
  encodeDeployData,
  formatEther,
  getCreate2Address,
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { baseSepolia } from 'viem/chains'

const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

const bridgeAbi = [
  {
    type: 'function',
    name: 'assetToken',
    stateMutability: 'view',
    inputs: [{ name: 'assetId', type: 'uint32' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'permissioned',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowed',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'shield',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assetId', type: 'uint32' },
      { name: 'amount', type: 'uint256' },
      { name: 'ownerTag', type: 'bytes32' },
    ],
    outputs: [{ name: 'depositId', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'addAllowed',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'member', type: 'address' }],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Shielded',
    inputs: [
      { name: 'depositId', type: 'uint64', indexed: true },
      { name: 'assetId', type: 'uint32', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'ownerTag', type: 'bytes32', indexed: false },
      { name: 'token', type: 'address', indexed: false },
      { name: 'from', type: 'address', indexed: false },
    ],
  },
] as const

export interface InjectedEthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
  isMetaMask?: boolean
  providers?: InjectedEthereumProvider[]
}

// --- EIP-6963 provider discovery ---------------------------------------------
// Grabbing `window.ethereum` blindly is fragile when several wallet extensions inject at once: they
// race for that single slot, so we may end up driving (or waking a wedged transport in) the wrong
// wallet. EIP-6963 replaces the race with an event handshake — each wallet announces itself with a
// stable `rdns`, letting us pick MetaMask (`io.metamask*`) deterministically. We register the
// announcement listener at module load and immediately request announcements; the protocol is
// symmetric (wallets also announce proactively on their own load), so either ordering is covered.
interface Eip6963ProviderDetail {
  info: { uuid: string; name: string; icon: string; rdns: string }
  provider: InjectedEthereumProvider
}

const announcedProviders = new Map<string, Eip6963ProviderDetail>()

if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (event) => {
    const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail
    if (detail?.info?.rdns && detail.provider) announcedProviders.set(detail.info.rdns, detail)
  })
  window.dispatchEvent(new Event('eip6963:requestProvider'))
}

/** Prefer a MetaMask provider (exact `io.metamask`, then any `io.metamask*` build like Flask/MMI). */
function metaMaskFromAnnouncements(): InjectedEthereumProvider | null {
  const exact = announcedProviders.get('io.metamask')
  if (exact) return exact.provider
  for (const detail of announcedProviders.values()) {
    if (detail.info.rdns.startsWith('io.metamask')) return detail.provider
  }
  return null
}

/** Deterministically resolve the injected provider, preferring MetaMask. Falls back through the
 * legacy `window.ethereum.providers` array and finally any single injected wallet, so non-MetaMask
 * setups keep working. */
function selectInjectedProvider(): InjectedEthereumProvider | null {
  const announced = metaMaskFromAnnouncements()
  if (announced) return announced

  const injected = (window as unknown as { ethereum?: InjectedEthereumProvider }).ethereum
  if (!injected) return null
  // Some wallets expose every injected provider on a `.providers` array when they collide.
  if (Array.isArray(injected.providers)) {
    const mm = injected.providers.find((p) => p.isMetaMask)
    if (mm) return mm
  }
  return injected
}

export function ethereumProvider(): InjectedEthereumProvider {
  const provider = selectInjectedProvider()
  if (!provider) throw new Error('No EVM wallet found. Install MetaMask (or another injected wallet).')
  return provider
}

// Kept as a local alias so existing transaction helpers remain concise.
const eth = ethereumProvider

/** Request accounts and switch the wallet to Base Sepolia. Returns the selected address. */
export async function connectBase(): Promise<Address> {
  const e = eth()
  const accounts = (await e.request({ method: 'eth_requestAccounts' })) as Address[]
  if (!accounts?.[0]) throw new Error('No account authorized in the EVM wallet.')
  try {
    // 84532 = 0x14a34
    await e.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] })
  } catch {
    // The user may need to add Base Sepolia manually; the shield call will fail loudly if so.
  }
  return accounts[0]
}

export async function currentBaseAccount(): Promise<Address | null> {
  const accounts = (await eth().request({ method: 'eth_accounts' })) as Address[]
  return accounts?.[0] ?? null
}

export async function currentChainId(): Promise<number | null> {
  const value = (await eth().request({ method: 'eth_chainId' })) as string
  return value ? Number.parseInt(value, 16) : null
}

export async function baseEthBalance(account: Address): Promise<bigint> {
  const client = createPublicClient({ chain: baseSepolia, transport: custom(eth()) })
  return client.getBalance({ address: account })
}

export function displayEth(value: bigint): string {
  return Number(formatEther(value)).toLocaleString(undefined, { maximumFractionDigits: 6 })
}

function rpcQuantity(value: bigint): Hex {
  return `0x${value.toString(16)}`
}

function dataBytes(data: Hex): number {
  return Math.max(0, (data.length - 2) / 2)
}

function providerErrorCode(error: unknown): number | string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as { code?: number | string }
  return record.code
}

function errorField(error: unknown, field: string): unknown {
  if (!error || typeof error !== 'object') return undefined
  return (error as Record<string, unknown>)[field]
}

function safeJson(value: unknown): string | null {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(value, (_key, entry) => {
      if (typeof entry === 'bigint') return entry.toString()
      if (entry && typeof entry === 'object') {
        if (seen.has(entry)) return '[Circular]'
        seen.add(entry)
      }
      return entry
    })
  } catch {
    return null
  }
}

/** Walk a viem/EIP-1193 error and its `cause` chain for a wallet user-rejection signal (code 4001,
 * viem's `UserRejectedRequestError`, or a "user rejected/denied" phrase). */
function isUserRejection(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current && typeof current === 'object' && depth < 10; depth += 1) {
    const record = current as { code?: number | string; name?: string; shortMessage?: string; message?: string; cause?: unknown }
    if (record.code === 4001 || record.code === 'ACTION_REJECTED') return true
    if (record.name === 'UserRejectedRequestError') return true
    if (/user (rejected|denied)/i.test(`${record.shortMessage ?? ''} ${record.message ?? ''}`)) return true
    current = record.cause
  }
  return false
}

/** The concise leading text of a message, dropping viem's verbose trailing blocks (Request Arguments,
 * Contract Call, Docs, Details, Version) that make raw wallet errors unreadable in the UI. */
function firstParagraph(text: string): string {
  const trimmed = text.trim()
  const cut = trimmed.search(/\n\n|\n(?:Request Arguments|Raw Call Arguments|Contract Call|Docs|Details|Version):/)
  return (cut === -1 ? trimmed : trimmed.slice(0, cut)).trim()
}

// Turn any wallet/RPC/app error into a short, user-facing string. The FULL error (viem dumps the
// calldata, contract call, docs link, cause chain, and version) is always logged to the console for
// debugging; only the concise summary is shown. viem errors carry a tidy `.shortMessage`, so prefer
// that over the giant multi-line `.message`.
export function errorMessage(error: unknown): string {
  console.error('[mosaic] error', error)
  if (isUserRejection(error)) return 'Request rejected in your wallet.'
  const short = errorField(error, 'shortMessage')
  if (typeof short === 'string' && short.trim()) return firstParagraph(short)
  const fields = [
    errorField(error, 'details'),
    errorField(errorField(error, 'data'), 'message'),
    errorField(errorField(error, 'data'), 'originalError'),
    error instanceof Error ? error.message : errorField(error, 'message'),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const code = providerErrorCode(error)
  if (fields.length > 0) return [code === undefined ? null : `code ${code}`, firstParagraph(fields[0])].filter(Boolean).join(': ')
  return safeJson(error) ?? String(error)
}

export interface BridgeDeploymentArtifact {
  abi: Abi
  bytecode: Hex
}

export interface BridgeDeploymentEstimate {
  gas: bigint
  maxFee: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/** Foundry/Arachnid deterministic CREATE2 deployment proxy — present at this address on every chain
 * it's been seeded on (Base Sepolia included). We deploy the bridge *through* this proxy so the
 * user's wallet signs an ordinary contract call (the tx has a `to`), sidestepping the wallet bug that
 * throws an internal -32603 "reading 'length'" on raw contract-creation (`to: null`) txs on OP-stack
 * chains. The proxy CREATE2-deploys `calldata[32:]` under the salt `calldata[0:32]`. */
const CREATE2_PROXY: Address = '0x4e59b44847b379578588920cA78FbF26c0B4956C'

interface BridgeDeploymentInputs {
  artifact: BridgeDeploymentArtifact
  account: Address
  assetIds: number[]
  tokens: Address[]
  /** Gate bridge deposits behind an owner-managed, add-only allowlist (permissioned desks). */
  permissioned?: boolean
  /** Initial Base allowlist members; only valid with `permissioned`. */
  initialAllowed?: Address[]
}

/** The contract creation code (runtime bytecode + ABI-encoded constructor args). */
function bridgeInitCode(opts: BridgeDeploymentInputs): Hex {
  return encodeDeployData({
    abi: opts.artifact.abi,
    bytecode: opts.artifact.bytecode,
    args: [opts.account, opts.assetIds, opts.tokens, opts.permissioned ?? false, opts.initialAllowed ?? []],
  })
}

/** A fresh random CREATE2 salt. Each deploy attempt targets a brand-new (empty) address, so the proxy
 * never reverts on an occupied slot and every attempt yields a real tx — matching the prior
 * one-contract-per-deploy semantics. */
function randomSalt(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

async function estimateProxyDeploy(account: Address, callData: Hex): Promise<BridgeDeploymentEstimate> {
  const pub = createPublicClient({ chain: baseSepolia, transport: custom(eth()) })
  const estimatedGas = await pub.estimateGas({ account, to: CREATE2_PROXY, data: callData })
  const fees = await pub.estimateFeesPerGas()
  const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? maxFeePerGas
  if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
    throw new Error('Base Sepolia RPC did not return usable gas fee estimates.')
  }
  // Include a 20% buffer because Base's L1 data component can move between estimate and inclusion.
  const gas = (estimatedGas * 120n) / 100n
  return { gas, maxFee: gas * maxFeePerGas, maxFeePerGas, maxPriorityFeePerGas }
}

export async function estimateBridgeDeployment(opts: BridgeDeploymentInputs): Promise<BridgeDeploymentEstimate> {
  const callData = concat([randomSalt(), bridgeInitCode(opts)])
  return estimateProxyDeploy(opts.account, callData)
}

export async function deployBridge(
  opts: BridgeDeploymentInputs,
): Promise<{ txHash: Hex; bridgeAddress: Address }> {
  const transport = custom(eth())
  const pub = createPublicClient({ chain: baseSepolia, transport })
  const wallet = createWalletClient({ account: opts.account, chain: baseSepolia, transport })

  // The deterministic proxy must exist on this chain for the CREATE2 route to work.
  const proxyCode = await pub.getCode({ address: CREATE2_PROXY })
  if (!proxyCode || proxyCode === '0x') {
    throw new Error(
      'The CREATE2 deployment proxy is not present on Base Sepolia. Deploy the bridge with '
        + '`forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast` and paste the address.',
    )
  }

  const initCode = bridgeInitCode(opts)
  const salt = randomSalt()
  const callData = concat([salt, initCode])
  // The proxy CREATE2-deploys initCode under `salt`; the resulting address is deterministic.
  const bridgeAddress = getCreate2Address({ from: CREATE2_PROXY, salt, bytecode: initCode })
  const prepared = await estimateProxyDeploy(opts.account, callData)

  const debug = {
    chain: baseSepolia.name,
    chainId: baseSepolia.id,
    from: opts.account,
    proxy: CREATE2_PROXY,
    bridgeAddress,
    assetIds: opts.assetIds,
    tokens: opts.tokens,
    gas: rpcQuantity(prepared.gas),
    maxFeePerGas: rpcQuantity(prepared.maxFeePerGas),
    maxPriorityFeePerGas: rpcQuantity(prepared.maxPriorityFeePerGas),
    dataBytes: dataBytes(callData),
    dataPrefix: `${callData.slice(0, 18)}...`,
  }
  console.info('[mosaic] Base bridge deployment request prepared', debug)
  let txHash: Hex
  try {
    // An ordinary call to the deterministic proxy (not a raw `to: null` creation, which several
    // injected wallets reject on OP-stack chains with an internal -32603 "reading 'length'").
    txHash = await wallet.sendTransaction({
      to: CREATE2_PROXY,
      data: callData,
      gas: prepared.gas,
      maxFeePerGas: prepared.maxFeePerGas,
      maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
    })
  } catch (ethError) {
    console.error('[mosaic] eth_sendTransaction failed for Base bridge deployment', {
      ...debug,
      error: ethError,
    })
    throw new Error(`Base bridge deployment request failed: ${errorMessage(ethError)}`, { cause: ethError })
  }
  console.info('[mosaic] Base bridge deployment transaction submitted', { ...debug, txHash })
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
  console.info('[mosaic] Base bridge deployment receipt', {
    txHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber?.toString(),
    gasUsed: receipt.gasUsed?.toString(),
    bridgeAddress,
    logCount: receipt.logs.length,
  })
  if (receipt.status !== 'success') {
    throw new Error(`The Base bridge deployment transaction reverted (tx ${txHash}).`)
  }

  // The proxy CREATE2-deploys the bridge in an internal call (no receipt.contractAddress), so the
  // address is the deterministic CREATE2 value computed above under a fresh random salt: a successful
  // receipt guarantees code will exist there. The deployed code can still lag the receipt on
  // load-balanced RPCs (and the smart-account/relayer path adds a beat), so poll to smooth the common
  // case — but return the confirmed deployment regardless, so a lagging read replica never strands a
  // real bridge or makes the retry mint a second one.
  let deployedCode: Hex | undefined
  for (let attempt = 1; attempt <= 8; attempt++) {
    deployedCode = await pub.getCode({ address: bridgeAddress })
    if (deployedCode && deployedCode !== '0x') break
    console.info('[mosaic] waiting for bridge code to propagate', { attempt, bridge: bridgeAddress })
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  if (!deployedCode || deployedCode === '0x') {
    console.warn('[mosaic] bridge code not yet visible after deploy; proceeding on the confirmed receipt', {
      txHash, bridgeAddress,
    })
  }
  return { txHash, bridgeAddress }
}

export interface BaseShieldResult {
  depositId: number
  txHash: Hex
}

/** May `account` deposit on this bridge? Always true on an open (non-permissioned) bridge.
 * Pre-permissioning bridges have neither view; treat a read failure as "allowed" so old desks
 * keep working (the bridge would revert a truly disallowed deposit anyway). */
export async function baseBridgeAllowed(bridge: Address, account: Address): Promise<boolean> {
  const pub = createPublicClient({ chain: baseSepolia, transport: custom(eth()) })
  try {
    const permissioned = (await pub.readContract({
      address: bridge,
      abi: bridgeAbi,
      functionName: 'permissioned',
    })) as boolean
    if (!permissioned) return true
    return (await pub.readContract({
      address: bridge,
      abi: bridgeAbi,
      functionName: 'allowed',
      args: [account],
    })) as boolean
  } catch {
    return true
  }
}

/** Owner-signed `addAllowed` on a permissioned bridge (trustless desks: the connected EVM wallet
 * is the bridge owner). Add-only, mirroring the Stellar allowlist. */
export async function baseBridgeAddAllowed(bridge: Address, member: Address, account: Address): Promise<Hex> {
  const transport = custom(eth())
  const wallet = createWalletClient({ account, chain: baseSepolia, transport })
  const pub = createPublicClient({ chain: baseSepolia, transport })
  const txHash = await wallet.writeContract({
    address: bridge,
    abi: bridgeAbi,
    functionName: 'addAllowed',
    args: [member],
  })
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success') throw new Error(`addAllowed reverted (tx ${txHash}).`)
  return txHash
}

/** approve(bridge, amount) then shield(assetId, amount, ownerTag); returns the deposit id. */
export async function baseShield(opts: {
  bridge: Address
  assetId: number
  amount: bigint
  ownerTag: Hex
  account: Address
}): Promise<BaseShieldResult> {
  const transport = custom(eth())
  const wallet = createWalletClient({ account: opts.account, chain: baseSepolia, transport })
  const pub = createPublicClient({ chain: baseSepolia, transport })

  const token = (await pub.readContract({
    address: opts.bridge,
    abi: bridgeAbi,
    functionName: 'assetToken',
    args: [opts.assetId],
  })) as Address
  if (/^0x0+$/.test(token)) throw new Error('That asset id is not registered on this bridge.')

  const approveHash = await wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [opts.bridge, opts.amount],
  })
  await pub.waitForTransactionReceipt({ hash: approveHash })

  const shieldHash = await wallet.writeContract({
    address: opts.bridge,
    abi: bridgeAbi,
    functionName: 'shield',
    args: [opts.assetId, opts.amount, opts.ownerTag],
  })
  const receipt = await pub.waitForTransactionReceipt({ hash: shieldHash })

  const events = parseEventLogs({ abi: bridgeAbi, eventName: 'Shielded', logs: receipt.logs })
  const ours = events.find(
    (e) => (e.args.ownerTag as string).toLowerCase() === opts.ownerTag.toLowerCase(),
  )
  if (!ours) throw new Error('Shielded event not found in the transaction receipt.')
  return { depositId: Number(ours.args.depositId), txHash: shieldHash }
}
