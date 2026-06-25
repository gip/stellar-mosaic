// Base (Sepolia) side of the shield bridge: connect an EVM wallet and call MosaicBridge.shield.
// The note's owner_tag is derived the same way as a native shield (see ShieldFromBaseForm), so the
// minted Stellar note reconciles by owner_tag and is spendable like any other.
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeDeployData,
  formatEther,
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

export interface BridgeDeploymentArtifact {
  abi: Abi
  bytecode: Hex
}

export interface BridgeDeploymentEstimate {
  gas: bigint
  maxFee: bigint
}

export async function estimateBridgeDeployment(opts: {
  artifact: BridgeDeploymentArtifact
  account: Address
  assetIds: number[]
  tokens: Address[]
}): Promise<BridgeDeploymentEstimate> {
  const transport = custom(eth())
  const pub = createPublicClient({ chain: baseSepolia, transport })
  const data = encodeDeployData({
    abi: opts.artifact.abi,
    bytecode: opts.artifact.bytecode,
    args: [opts.account, opts.assetIds, opts.tokens],
  })
  const gas = await pub.estimateGas({ account: opts.account, data })
  const fees = await pub.estimateFeesPerGas()
  // Include a 20% buffer because Base's L1 data component can move between estimate and inclusion.
  return { gas, maxFee: (gas * fees.maxFeePerGas * 120n) / 100n }
}

export async function deployBridge(opts: {
  artifact: BridgeDeploymentArtifact
  account: Address
  assetIds: number[]
  tokens: Address[]
}): Promise<{ txHash: Hex; bridgeAddress: Address }> {
  const transport = custom(eth())
  const wallet = createWalletClient({ account: opts.account, chain: baseSepolia, transport })
  const pub = createPublicClient({ chain: baseSepolia, transport })
  const txHash = await wallet.deployContract({
    abi: opts.artifact.abi,
    bytecode: opts.artifact.bytecode,
    args: [opts.account, opts.assetIds, opts.tokens],
    account: opts.account,
    chain: baseSepolia,
  })
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error('The Base bridge deployment transaction failed.')
  }
  return { txHash, bridgeAddress: receipt.contractAddress }
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
