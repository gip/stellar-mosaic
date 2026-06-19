// Sponsored shield, built in the browser. `shield` moves the user's own tokens into custody, so it
// needs the user's authorization — but the desk SPONSOR is the transaction source and pays the fee.
// The user signs ONLY the Soroban auth entry (via Freighter); the backend adds the sponsor's
// envelope signature and submits. Note secrets never touch this path.
import {
  rpc,
  Contract,
  TransactionBuilder,
  Networks,
  Address,
  Operation,
  nativeToScVal,
  xdr,
  authorizeEntry,
  BASE_FEE,
} from '@stellar/stellar-sdk'
import { signAuthEntry } from '@stellar/freighter-api'
import { Buffer } from 'buffer'

const RPC_URL = import.meta.env.VITE_SOROBAN_RPC ?? 'https://soroban-testnet.stellar.org'
const PASSPHRASE = Networks.TESTNET

/**
 * Build a sponsored shield transaction: source = sponsor, op authorized by a user-signed auth
 * entry. Returns the transaction XDR with an UNSIGNED envelope (the backend signs + submits it).
 */
export async function buildSponsoredShield(
  contractId: string,
  sponsorPubkey: string,
  userPubkey: string,
  assetId: number,
  amount: string,
  ownerTagBytes: Uint8Array,
): Promise<string> {
  const srv = new rpc.Server(RPC_URL)
  const args = [
    new Address(userPubkey).toScVal(),
    nativeToScVal(assetId, { type: 'u32' }),
    nativeToScVal(BigInt(amount), { type: 'i128' }),
    xdr.ScVal.scvBytes(Buffer.from(ownerTagBytes)),
  ]

  // 1. Build with the sponsor as source and simulate to discover the required auth.
  const simAccount = await srv.getAccount(sponsorPubkey)
  const probe = new TransactionBuilder(simAccount, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call('shield', ...args))
    .setTimeout(120)
    .build()
  const sim = await srv.simulateTransaction(probe)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`)

  // 2. User signs each auth entry via Freighter (signs hash(preimage); authorizeEntry verifies it).
  const validUntil = sim.latestLedger + 60
  const auth = sim.result?.auth ?? []
  const signed = await Promise.all(
    auth.map((entry) =>
      authorizeEntry(
        entry,
        async (preimage) => {
          const res = await signAuthEntry(preimage.toXDR('base64'), {
            address: userPubkey,
            networkPassphrase: PASSPHRASE,
          })
          if (res.error) throw new Error(String(res.error))
          if (!res.signedAuthEntry) throw new Error('Freighter returned no signature')
          return Buffer.from(res.signedAuthEntry, 'base64')
        },
        validUntil,
        PASSPHRASE,
      ),
    ),
  )

  // 3. Assemble the final tx with the signed auth + simulated Soroban resources; leave it unsigned.
  const account = await srv.getAccount(sponsorPubkey)
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(contractId).toScAddress(),
      functionName: 'shield',
      args,
    }),
  )
  const op = Operation.invokeHostFunction({ func, auth: signed })
  const fee = String(Number(BASE_FEE) + Number(sim.minResourceFee))
  const tx = new TransactionBuilder(account, { fee, networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setSorobanData(sim.transactionData.build())
    .setTimeout(120)
    .build()
  return tx.toXDR()
}
