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
}

export function ethereumProvider(): InjectedEthereumProvider {
  const e = (window as unknown as { ethereum?: InjectedEthereumProvider }).ethereum
  if (!e) throw new Error('No EVM wallet found. Install MetaMask (or another injected wallet).')
  return e
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

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  const fields = [
    errorField(error, 'message'),
    errorField(error, 'shortMessage'),
    errorField(error, 'details'),
    errorField(errorField(error, 'data'), 'message'),
    errorField(errorField(error, 'data'), 'originalError'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  const code = providerErrorCode(error)
  if (fields.length > 0) return [code === undefined ? null : `code ${code}`, ...fields].filter(Boolean).join(': ')
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
}

/** The contract creation code (runtime bytecode + ABI-encoded constructor args). */
function bridgeInitCode(opts: BridgeDeploymentInputs): Hex {
  return encodeDeployData({
    abi: opts.artifact.abi,
    bytecode: opts.artifact.bytecode,
    args: [opts.account, opts.assetIds, opts.tokens],
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
  // address is the deterministic CREATE2 value computed above. The deployed code can lag behind the
  // receipt on load-balanced RPCs, so poll a few times before giving up.
  let deployedCode: Hex | undefined
  for (let attempt = 1; attempt <= 8; attempt++) {
    deployedCode = await pub.getCode({ address: bridgeAddress })
    if (deployedCode && deployedCode !== '0x') break
    console.info('[mosaic] waiting for bridge code to propagate', { attempt, bridge: bridgeAddress })
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  if (!deployedCode || deployedCode === '0x') {
    throw new Error(
      `The Base bridge deployment confirmed (tx ${txHash}) but no contract code is visible at `
        + `${bridgeAddress} yet — usually RPC propagation lag. Check the tx on `
        + 'https://sepolia.basescan.org, then hit retry (it reuses this deployment).',
    )
  }
  return { txHash, bridgeAddress }
}

export interface BaseShieldResult {
  depositId: number
  txHash: Hex
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
