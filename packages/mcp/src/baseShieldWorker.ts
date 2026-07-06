// Durable Base->Stellar shield worker (the MCP counterpart of the old backend/src/base_shield.rs).
//
// Each tick advances the oldest job in each lifecycle stage by one step (guarded so a slow tick
// never overlaps the next), so one deposit's finality wait doesn't block the next deposit's
// proving — the stages pipeline. State machine:
//
//   proving           -> submit the prove job to the remote service (idempotent), then poll it.
//                        `done` -> persist seal/journal + committed block -> awaiting_finality.
//   awaiting_finality -> direct JSON-RPC finality check; once finalized -> minting.
//   minting           -> attest the block hash + shield_from_base via the desk sponsor -> active.
//   active | failed   -> terminal.
//
// Durable both ways: the job row (with persisted seal_hex/journal_hex) survives an MCP restart, and
// the remote prove service caches completed proofs on disk. A restart mid-flight simply resubmits or
// re-polls; nothing re-holds a connection or loses work.
//
// Error policy: every step failure bumps the job's `attempts` counter and leaves it in its stage —
// the next tick retries — until an attempt cap, and only then moves it to the terminal `failed`.
// The counter resets on every stage transition. The cap depends on the failure class: a
// service-reported prove error (a full ~10-min re-prove per retry) and a failed mint submission
// (a real on-chain attempt) get tight caps, while transport-level throws (prove service/Base
// RPC/store unreachable) get a generous cap — the single shared counter is judged against the cap
// of whichever class the latest failure belongs to. A mint rejected with the contract's
// `DepositAlreadyProcessed` (#27) means a previous attempt (possibly right before a crash) already
// minted the note, so the job is marked `active`, not `failed`.

import {
  DepositAlreadyProcessedError,
  isFinalized,
  mintOnStellar,
  pollProve,
  submitProve,
  type BaseShieldConfig,
} from "./baseShield.js";
import { errorMessage, type BaseShieldJob, type MosaicLogger } from "@mosaic/sdk";
import type { MosaicStore } from "./store.js";

export interface BaseShieldWorkerHandle {
  stop(): void;
}

/** The external side effects one tick is built from — injectable so tests can drive the worker
 * without a prove service, a Base RPC, or the `stellar` CLI. */
export interface BaseShieldSteps {
  submitProve: typeof submitProve;
  pollProve: typeof pollProve;
  isFinalized: typeof isFinalized;
  mintOnStellar: typeof mintOnStellar;
}

const defaultSteps: BaseShieldSteps = { submitProve, pollProve, isFinalized, mintOnStellar };

const DEFAULT_INTERVAL_MS = 12_000;

// Failure caps before a job goes terminal. Each prove retry is a full re-prove (~10 min on the
// service), so it gets fewer attempts than the ~seconds-long mint submission. Transport-level
// throws (prove service/Base RPC/store unreachable) are cheap and usually an outage rather than a
// property of the job, so they get a generous cap (~10 min of continuous failure at the default
// 12s interval) — finite, so a poisoned job cannot head-of-line-block its stage forever.
const PROVE_MAX_ATTEMPTS = 3;
const MINT_MAX_ATTEMPTS = 5;
export const TRANSPORT_MAX_ATTEMPTS = 50;

type Job = BaseShieldJob;
type Logger = Pick<MosaicLogger, "info" | "warn">;

const noopLog: Logger = { info: () => {}, warn: () => {} };

/**
 * Start the background worker. No-op-safe to call once per server; returns a handle whose `stop()`
 * clears the timer. Each tick advances at most one job per lifecycle stage by one step.
 */
export function startBaseShieldWorker(
  store: MosaicStore,
  config: BaseShieldConfig,
  opts: {
    intervalMs?: number;
    logger?: Logger;
    steps?: BaseShieldSteps;
  } = {},
): BaseShieldWorkerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = opts.logger ?? noopLog;
  const steps = opts.steps ?? defaultSteps;
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      await runBaseShieldTick(store, config, steps, log);
    } catch (e) {
      log.warn(`base-shield worker tick failed: ${errorMessage(e)}`);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Don't keep the process alive solely for the worker.
  if (typeof timer.unref === "function") timer.unref();
  log.info("base-shield worker started");
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** One worker tick: advance the oldest job in each active stage by one step. */
export async function runBaseShieldTick(
  store: MosaicStore,
  config: BaseShieldConfig,
  steps: BaseShieldSteps = defaultSteps,
  log: Logger = noopLog,
): Promise<void> {
  const jobs = await store.nextBaseShields();
  for (const job of jobs) {
    // Per-job guard: one stage failing must not skip this tick's other stages.
    try {
      if (job.status === "proving") await advanceProving(store, config, steps, job, log);
      else if (job.status === "awaiting_finality") await advanceFinality(store, config, steps, job, log);
      else if (job.status === "minting") await advanceMinting(store, config, steps, job, log);
    } catch (e) {
      // Transport-level throws (prove service/Base RPC/store unreachable) must still count toward
      // a terminal state: an uncounted failure would retry forever, invisibly (no persisted
      // error), and head-of-line-block its whole stage (the batch is oldest-per-stage).
      try {
        await retryOrFail(store, job, `${job.status}: ${errorMessage(e)}`, TRANSPORT_MAX_ATTEMPTS, log);
      } catch (bookkeeping) {
        log.warn(`base-shield ${job.id}: step failed (${errorMessage(e)}) and retry bookkeeping failed: ${errorMessage(bookkeeping)}`);
      }
    }
  }
}

/** Bump the job's attempt counter and keep it in its stage, or fail it once past `maxAttempts`. */
async function retryOrFail(store: MosaicStore, job: Job, error: string, maxAttempts: number, log: Logger): Promise<void> {
  const attempt = (job.attempts ?? 0) + 1;
  if (attempt >= maxAttempts) {
    await store.baseShieldFailed(job.id, error);
    log.warn(`base-shield ${job.id}: ${error} (attempt ${attempt}/${maxAttempts}, giving up)`);
  } else {
    await store.baseShieldRetry(job.id, error);
    log.warn(`base-shield ${job.id}: ${error} (attempt ${attempt}/${maxAttempts}, will retry)`);
  }
}

async function advanceProving(store: MosaicStore, config: BaseShieldConfig, steps: BaseShieldSteps, job: Job, log: Logger): Promise<void> {
  // Idempotent submit (a completed/running job is a no-op on the service), then read status.
  await steps.submitProve(config, { jobId: job.id, bridge: job.bridge, depositId: job.deposit_id });
  const result = await steps.pollProve(config, job.id);
  switch (result.status) {
    case "done": {
      // Per-desk gate: only wait for Base L1 finality when the desk opted in (default off).
      const desk = await store.getDesk(job.desk_id);
      const requireFinality = desk.base_deployment?.require_finality === true;
      await store.baseShieldProved(job.id, result.block_number, result.block_hash, result.seal_hex, result.journal_hex, requireFinality);
      log.info(
        `base-shield ${job.id}: proved at block ${result.block_number}; ${requireFinality ? "awaiting finality" : "minting (finality wait off)"}`,
      );
      break;
    }
    case "error":
      // The service treats a prior error as retryable: the next tick's submit starts a fresh run.
      await retryOrFail(store, job, `prove: ${result.error}`, PROVE_MAX_ATTEMPTS, log);
      break;
    // "running" -> wait; "not_started" (service restarted) -> next tick resubmits.
  }
}

async function advanceFinality(store: MosaicStore, config: BaseShieldConfig, steps: BaseShieldSteps, job: Job, log: Logger): Promise<void> {
  if (job.block_number == null) {
    await store.baseShieldFailed(job.id, "awaiting_finality without a committed block");
    return;
  }
  if (await steps.isFinalized(config.baseRpc, job.block_number)) {
    await store.baseShieldStatus(job.id, "minting");
    log.info(`base-shield ${job.id}: block ${job.block_number} finalized; minting`);
  }
}

async function advanceMinting(store: MosaicStore, config: BaseShieldConfig, steps: BaseShieldSteps, job: Job, log: Logger): Promise<void> {
  if (job.block_number == null || !job.block_hash || !job.seal_hex || !job.journal_hex) {
    await store.baseShieldFailed(job.id, "minting without persisted proof artifacts");
    return;
  }
  const sponsorSecret = await store.sponsorSecret(job.desk_id);
  if (!sponsorSecret) {
    await store.baseShieldFailed(job.id, "desk has no sponsor key (cannot mint)");
    return;
  }
  const desk = await store.getDesk(job.desk_id);
  try {
    const { txHash } = await steps.mintOnStellar(config, {
      contractId: desk.contract_id,
      sponsorSecret,
      jobId: job.id,
      blockNumber: job.block_number,
      blockHash: job.block_hash,
      sealHex: job.seal_hex,
      journalHex: job.journal_hex,
    });
    await store.baseShieldStatus(job.id, "active", txHash);
    log.info(`base-shield ${job.id}: minted (${txHash})`);
  } catch (e) {
    if (e instanceof DepositAlreadyProcessedError) {
      // A previous attempt landed (e.g. the process died between the mint and the status write).
      // The note exists on-chain, so the job is done; the mint tx hash from that attempt is lost.
      await store.baseShieldStatus(job.id, "active");
      log.info(`base-shield ${job.id}: deposit already minted on-chain; marking active`);
      return;
    }
    await retryOrFail(store, job, `mint: ${errorMessage(e)}`, MINT_MAX_ATTEMPTS, log);
  }
}
