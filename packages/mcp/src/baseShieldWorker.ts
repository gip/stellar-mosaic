// Durable Base->Stellar shield worker (the MCP counterpart of the old backend/src/base_shield.rs).
//
// One step per tick, guarded so a slow step never overlaps the next tick. State machine:
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

import {
  isFinalized,
  mintOnStellar,
  pollProve,
  submitProve,
  type BaseShieldConfig,
} from "./baseShield.js";
import type { BaseShieldJob } from "@mosaic/sdk";
import type { MosaicStore } from "./store.js";

export interface BaseShieldWorkerHandle {
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 12_000;

/**
 * Start the background worker. No-op-safe to call once per server; returns a handle whose `stop()`
 * clears the timer. Each tick advances at most one job by one step.
 */
export function startBaseShieldWorker(
  store: MosaicStore,
  config: BaseShieldConfig,
  opts: { intervalMs?: number; logger?: { info: (m: string) => void; warn: (m: string) => void } } = {},
): BaseShieldWorkerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = opts.logger ?? { info: () => {}, warn: () => {} };
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const job = await store.nextBaseShield();
      if (!job) return;
      if (job.status === "proving") await advanceProving(store, config, job, log);
      else if (job.status === "awaiting_finality") await advanceFinality(store, config, job, log);
      else if (job.status === "minting") await advanceMinting(store, config, job, log);
    } catch (e) {
      log.warn(`base-shield worker tick failed: ${e instanceof Error ? e.message : String(e)}`);
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

type Job = BaseShieldJob;
type Logger = { info: (m: string) => void; warn: (m: string) => void };

async function advanceProving(store: MosaicStore, config: BaseShieldConfig, job: Job, log: Logger): Promise<void> {
  // Idempotent submit (a completed/running job is a no-op on the service), then read status.
  await submitProve(config, { jobId: job.id, bridge: job.bridge, depositId: job.deposit_id });
  const result = await pollProve(config, job.id);
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
      await store.baseShieldFailed(job.id, `prove: ${result.error}`);
      log.warn(`base-shield ${job.id}: prove failed: ${result.error}`);
      break;
    // "running" -> wait; "not_started" (service restarted) -> next tick resubmits.
  }
}

async function advanceFinality(store: MosaicStore, config: BaseShieldConfig, job: Job, log: Logger): Promise<void> {
  if (job.block_number == null) {
    await store.baseShieldFailed(job.id, "awaiting_finality without a committed block");
    return;
  }
  if (await isFinalized(config.baseRpc, job.block_number)) {
    await store.baseShieldStatus(job.id, "minting");
    log.info(`base-shield ${job.id}: block ${job.block_number} finalized; minting`);
  }
}

async function advanceMinting(store: MosaicStore, config: BaseShieldConfig, job: Job, log: Logger): Promise<void> {
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
    const { txHash } = await mintOnStellar(config, {
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
    await store.baseShieldFailed(job.id, `mint: ${e instanceof Error ? e.message : String(e)}`);
    log.warn(`base-shield ${job.id}: mint failed`);
  }
}
