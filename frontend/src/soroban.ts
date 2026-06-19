// Soroban transaction helpers run in the browser. Used for `shield`, which moves the user's own
// tokens into custody and therefore needs the user's signature (Freighter). Relayer-submittable
// actions (order/unshield/cancel) go through the backend instead and need no signature.
import {
  rpc,
  Contract,
  TransactionBuilder,
  Networks,
  Address,
  nativeToScVal,
  xdr,
  BASE_FEE,
} from '@stellar/stellar-sdk'
import { signTransaction } from '@stellar/freighter-api'
import { Buffer } from 'buffer'

const RPC_URL = import.meta.env.VITE_SOROBAN_RPC ?? 'https://soroban-testnet.stellar.org'
const PASSPHRASE = Networks.TESTNET

function server() {
  return new rpc.Server(RPC_URL)
}

/**
 * Shield `amount` of `asset_id` from the connected user into the desk's custody, minting an asset
 * note committed to `ownerTagBytes` (32 bytes). User-signed via Freighter. Returns the tx hash.
 */
export async function shield(
  contractId: string,
  userPubkey: string,
  assetId: number,
  amount: string,
  ownerTagBytes: Uint8Array,
): Promise<string> {
  const srv = server()
  const account = await srv.getAccount(userPubkey)
  const contract = new Contract(contractId)

  const op = contract.call(
    'shield',
    new Address(userPubkey).toScVal(),
    nativeToScVal(assetId, { type: 'u32' }),
    nativeToScVal(BigInt(amount), { type: 'i128' }),
    xdr.ScVal.scvBytes(Buffer.from(ownerTagBytes)),
  )

  const built = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(60)
    .build()

  // Simulate to fill footprint + resource fee (and surface auth requirements).
  const prepared = await srv.prepareTransaction(built)

  const signed = await signTransaction(prepared.toXDR(), {
    networkPassphrase: PASSPHRASE,
    address: userPubkey,
  })
  if (signed.error) throw new Error(String(signed.error))

  const tx = TransactionBuilder.fromXDR(signed.signedTxXdr, PASSPHRASE)
  const sent = await srv.sendTransaction(tx)
  if (sent.status === 'ERROR') {
    throw new Error(`submit failed: ${JSON.stringify(sent.errorResult ?? sent)}`)
  }
  return await poll(srv, sent.hash)
}

async function poll(srv: rpc.Server, hash: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const r = await srv.getTransaction(hash)
    if (r.status === 'SUCCESS') return hash
    if (r.status === 'FAILED') throw new Error(`tx ${hash} failed on-chain`)
  }
  throw new Error(`tx ${hash} not confirmed in time`)
}
