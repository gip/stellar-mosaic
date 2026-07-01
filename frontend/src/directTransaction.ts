import { openDB, type DBSchema } from 'idb'
import { signTransaction } from '@stellar/freighter-api'
import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  type xdr,
} from '@stellar/stellar-sdk'
import { currentAddress, network } from './wallet'
import { SOROBAN_RPC_URL } from './config'
import { errorMessage, transactionErrorMessage } from '@mosaic/sdk'

interface SubmissionRecord {
  hash: string
  contract_id: string
  method: string
  source: string
  network_passphrase: string
  status: 'prepared' | 'submitted' | 'succeeded' | 'failed'
  created_at: number
  updated_at: number
  error?: string
}

interface SubmissionDB extends DBSchema {
  submissions: {
    key: string
    value: SubmissionRecord
  }
}

const db = openDB<SubmissionDB>('mosaic-submissions', 1, {
  upgrade(database) {
    database.createObjectStore('submissions', { keyPath: 'hash' })
  },
})

export function submissionMode(): 'direct' | 'sponsored' {
  return localStorage.getItem('mosaic-submission-mode') === 'sponsored' ? 'sponsored' : 'direct'
}

export function setSubmissionMode(mode: 'direct' | 'sponsored'): void {
  localStorage.setItem('mosaic-submission-mode', mode)
}

async function update(record: SubmissionRecord, patch: Partial<SubmissionRecord>): Promise<void> {
  await (await db).put('submissions', { ...record, ...patch, updated_at: Date.now() })
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

/** Build, simulate, Freighter-sign, submit, and confirm one user-funded Soroban invocation. */
export async function submitContractCall(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  metadata?: Record<string, unknown>,
): Promise<string> {
  const [source, selectedNetwork] = await Promise.all([currentAddress(), network()])
  if (!source) throw new Error('Connect Freighter before submitting.')
  if (!selectedNetwork?.networkPassphrase) throw new Error('Freighter did not return a network passphrase.')
  const networkPassphrase = selectedNetwork.networkPassphrase
  const server = new rpc.Server(SOROBAN_RPC_URL)
  const account = await server.getAccount(source)
  const raw = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(120)
    .build()
  const simulation = await server.simulateTransaction(raw)
  const call = { contractId, method, args, metadata }
  if (rpc.Api.isSimulationError(simulation)) throw new Error(transactionErrorMessage(simulation.error, call))
  const assembled = rpc.assembleTransaction(raw, simulation).build()
  const hash = assembled.hash().toString('hex')
  const record: SubmissionRecord = {
    hash,
    contract_id: contractId,
    method,
    source,
    network_passphrase: networkPassphrase,
    status: 'prepared',
    created_at: Date.now(),
    updated_at: Date.now(),
  }
  await (await db).put('submissions', record)

  const signed = await signTransaction(assembled.toXDR(), { address: source, networkPassphrase })
  if (signed.error || !signed.signedTxXdr) {
    const message = signed.error ? errorMessage(signed.error) : 'Freighter returned no signed transaction.'
    await update(record, { status: 'failed', error: message })
    throw new Error(message)
  }
  const transaction = TransactionBuilder.fromXDR(signed.signedTxXdr, networkPassphrase)
  // Mark submitted before the network call: if the response is lost after acceptance, reload
  // reconciliation can still query the deterministic transaction hash.
  await update(record, { status: 'submitted' })
  const sent = await server.sendTransaction(transaction)
  if (sent.status !== 'PENDING' && sent.status !== 'DUPLICATE') {
    const message = transactionErrorMessage(`RPC rejected transaction ${hash}: ${sent.status}`, call)
    await update(record, { status: 'failed', error: message })
    throw new Error(message)
  }
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await server.getTransaction(hash)
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      await update(record, { status: 'succeeded' })
      return hash
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      const message = transactionErrorMessage(`Transaction ${hash} failed in ledger ${result.ledger}`, call)
      await update(record, { status: 'failed', error: message })
      throw new Error(message)
    }
    await sleep(1000)
  }
  throw new Error(`Transaction ${hash} is still pending; its status is saved locally.`)
}

export async function submitDirectOrSponsored(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  sponsored: () => Promise<unknown>,
): Promise<string | undefined> {
  if (submissionMode() === 'sponsored') {
    await sponsored()
    return undefined
  }
  return submitContractCall(contractId, method, args)
}

/** Refresh locally journaled submissions after a reload or lost RPC response. */
export async function reconcileDirectSubmissions(): Promise<void> {
  const database = await db
  for (const record of await database.getAll('submissions')) {
    if (record.status !== 'submitted') continue
    try {
      const result = await new rpc.Server(SOROBAN_RPC_URL).getTransaction(record.hash)
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        await update(record, { status: 'succeeded' })
      } else if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        await update(record, {
          status: 'failed',
          error: `Transaction failed in ledger ${result.ledger}`,
        })
      }
    } catch {
      // Preserve the journal and retry on the next application load.
    }
  }
}
