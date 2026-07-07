// Base-shield jobs -> Activity events. The MCP `BaseShieldJob` is the durable, server-side record of
// a Base -> Stellar shield (like an Operation is for native trusted-mode actions), so Activity renders
// straight from it: entries appear the moment a job exists — on any device, at any job status —
// without depending on best-effort browser-local writes. The job carries everything both legs need:
// `deposit.{asset_id,symbol,decimals,amount,base_tx_hash}` captured at enqueue, and `stellar_tx_hash`
// once the worker mints. Events synthesized here are in-memory display state (never persisted); they
// share `metadata.action_id` (the job id) and idempotency keys with the persisted legs, so both
// sources collapse into one group with one line per transaction.
import type { ActivityEvent, BaseShieldJob } from '@mosaic/sdk'

/** The Base-deposit leg of a shield job: the Base Sepolia tx that locked the funds. */
export function baseShieldDepositEvent(job: BaseShieldJob, wallet?: string): ActivityEvent {
  const deposit = job.deposit ?? {}
  return {
    kind: 'transaction',
    action: 'shield_from_base',
    method: 'shield_from_base',
    status: 'running',
    wallet_address: wallet,
    desk_id: job.desk_id,
    tx_hash: deposit.base_tx_hash,
    idempotency_key: `base-shield-deposit:${job.id}`,
    metadata: {
      action_id: job.id,
      source: 'base',
      asset_id: deposit.asset_id,
      symbol: deposit.symbol,
      decimals: deposit.decimals,
      amount: deposit.amount,
      base_tx_hash: deposit.base_tx_hash,
      deposit_id: job.deposit_id,
    },
  }
}

/** The Stellar-side status leg of a shield job: the mint tx on success, the failure, or the in-flight
 * progress (queued/proving/awaiting_finality/minting). Re-asserts the Base deposit tx on success so
 * that leg's dot flips green alongside the Stellar one. */
export function baseShieldStatusEvent(job: BaseShieldJob, wallet?: string, baseTxHash?: string): ActivityEvent {
  const baseTx = baseTxHash ?? job.deposit?.base_tx_hash
  const base = baseTx ? { base_tx_hash: baseTx } : {}
  const deposit = {
    asset_id: job.deposit?.asset_id,
    symbol: job.deposit?.symbol,
    decimals: job.deposit?.decimals,
    amount: job.deposit?.amount,
  }
  if (job.status === 'failed') {
    return {
      kind: 'error',
      action: 'shield_from_base',
      method: 'shield_from_base',
      status: 'failed',
      wallet_address: wallet,
      desk_id: job.desk_id,
      message: job.error ?? undefined,
      idempotency_key: `base-shield-fail:${job.id}`,
      metadata: { action_id: job.id, source: 'base', ...deposit, ...base },
    }
  }
  if (job.status === 'active') {
    return {
      kind: 'transaction',
      action: 'shield_from_base',
      method: 'shield_from_base',
      status: 'succeeded',
      wallet_address: wallet,
      desk_id: job.desk_id,
      tx_hash: job.stellar_tx_hash ?? undefined,
      idempotency_key: `base-shield-mint:${job.id}`,
      metadata: { action_id: job.id, source: 'base', ...deposit, stellar_tx_hash: job.stellar_tx_hash ?? undefined, ...base },
    }
  }
  return {
    kind: 'transaction',
    action: 'shield_from_base',
    method: 'shield_from_base',
    status: 'running',
    wallet_address: wallet,
    desk_id: job.desk_id,
    idempotency_key: `base-shield-status:${job.id}`,
    metadata: { action_id: job.id, source: 'base', ...deposit, ...base },
  }
}

/** In-memory Activity events for every job: the deposit leg plus the current-status leg. `created_at`
 * is intentionally left unset — these are re-synthesized each poll, and a fresh timestamp would pin
 * every job to "just now" and the top of the list; the persisted legs carry the real times. */
export function baseShieldJobEvents(jobs: BaseShieldJob[], wallet?: string): ActivityEvent[] {
  return jobs.flatMap((job) => [baseShieldDepositEvent(job, wallet), baseShieldStatusEvent(job, wallet)])
}
