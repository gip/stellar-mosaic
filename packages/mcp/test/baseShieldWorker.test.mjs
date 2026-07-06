// Worker error-policy tests, driven tick-by-tick via runBaseShieldTick with injected step
// functions (no prove service, no Base RPC, no `stellar` CLI). Covers the crash-recovery gaps:
// a re-mint rejected as DepositAlreadyProcessed resolves to `active`, transient prove/mint
// failures retry up to the stage cap instead of failing terminally on first error, and
// transport-level throws (service/RPC unreachable) are counted and capped rather than looping
// invisibly forever.
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryMosaicStore } from "../dist/store.js";
import { runBaseShieldTick, TRANSPORT_MAX_ATTEMPTS } from "../dist/baseShieldWorker.js";
import { DepositAlreadyProcessedError } from "../dist/baseShield.js";

const BASE_BRIDGE = "0xabababababababababababababababababababab";
const CFG = {
  proveServiceUrl: "https://prover.example",
  proveToken: "tok",
  baseRpc: "https://base.example",
  stellar: { rpcUrl: "https://soroban.example", networkPassphrase: "Test SDF Network ; September 2015" },
};

const PROVED = { status: "done", seal_hex: "aa", journal_hex: "bb", block_number: 42, block_hash: "cd".repeat(32) };

async function storeWithJob(depositId = 7) {
  const store = new MemoryMosaicStore();
  await store.insertDesk(
    {
      id: "desk-base",
      name: "Base desk",
      contract_id: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      sponsor_pubkey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      event_start_ledger: 1,
      assets: [],
      pairs: [],
      base_deployment: { status: "active", bridge_address: BASE_BRIDGE, deployer_address: "0x0", tx_hash: "0x0", error: null, assets: [] },
    },
    "SA_SPONSOR_SECRET",
  );
  const job = await store.enqueueBaseShield("desk-base", BASE_BRIDGE, depositId);
  return { store, job };
}

async function jobState(store, id) {
  return (await store.listBaseShields("desk-base")).find((j) => j.id === id);
}

/** Steps whose prove side always reports done; mint behavior is supplied by the test. */
function steps(mint, overrides = {}) {
  return {
    submitProve: async () => ({ status: "running" }),
    pollProve: async () => PROVED,
    isFinalized: async () => true,
    mintOnStellar: mint,
    ...overrides,
  };
}

test("happy path: proving -> minting (finality off by default) -> active with the mint tx hash", async () => {
  const { store, job } = await storeWithJob();
  const s = steps(async () => ({ txHash: "ef".repeat(32) }));

  await runBaseShieldTick(store, CFG, s);
  assert.equal((await jobState(store, job.id)).status, "minting", "require_finality absent -> straight to minting");
  await runBaseShieldTick(store, CFG, s);
  const done = await jobState(store, job.id);
  assert.equal(done.status, "active");
  assert.equal(done.stellar_tx_hash, "ef".repeat(32));
});

test("mint rejected as DepositAlreadyProcessed marks the job active, not failed", async () => {
  const { store, job } = await storeWithJob();
  await store.baseShieldProved(job.id, 42, "cd".repeat(32), "aa", "bb", false);

  // The re-mint after a crash-between-mint-and-status-write: mintOnStellar classified the
  // contract's #27 (deposit already minted a note), meaning a previous attempt landed.
  const s = steps(async () => {
    throw new DepositAlreadyProcessedError("transaction simulation failed: HostError: Error(Contract, #27)");
  });
  await runBaseShieldTick(store, CFG, s);

  const done = await jobState(store, job.id);
  assert.equal(done.status, "active");
  assert.equal(done.error, null);
  assert.ok(!done.stellar_tx_hash, "the original mint's tx hash is unknown");
});

test("transient mint errors retry in-stage and only fail after the attempt cap", async () => {
  const { store, job } = await storeWithJob();
  await store.baseShieldProved(job.id, 42, "cd".repeat(32), "aa", "bb", false);

  let calls = 0;
  const s = steps(async () => {
    calls += 1;
    throw new Error("stellar rpc: connection reset");
  });

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await runBaseShieldTick(store, CFG, s);
    const state = await jobState(store, job.id);
    assert.equal(state.status, "minting", `attempt ${attempt} stays in minting`);
    assert.equal(state.attempts, attempt);
    assert.match(state.error, /connection reset/);
  }

  // Fifth failure hits MINT_MAX_ATTEMPTS -> terminal.
  await runBaseShieldTick(store, CFG, s);
  const failed = await jobState(store, job.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /mint: .*connection reset/);
  assert.equal(calls, 5);

  // Terminal jobs are no longer picked up.
  await runBaseShieldTick(store, CFG, s);
  assert.equal(calls, 5);
});

test("a mint success after transient failures resets the attempt counter", async () => {
  const { store, job } = await storeWithJob();
  await store.baseShieldProved(job.id, 42, "cd".repeat(32), "aa", "bb", false);

  let calls = 0;
  const s = steps(async () => {
    calls += 1;
    if (calls < 3) throw new Error("sequence collision");
    return { txHash: "ef".repeat(32) };
  });
  await runBaseShieldTick(store, CFG, s);
  await runBaseShieldTick(store, CFG, s);
  await runBaseShieldTick(store, CFG, s);

  const done = await jobState(store, job.id);
  assert.equal(done.status, "active");
  assert.equal(done.attempts, 0, "stage transition clears the counter");
  assert.equal(done.error, null);
});

test("prove-service errors resubmit on later ticks and only fail after the attempt cap", async () => {
  const { store, job } = await storeWithJob();

  let submits = 0;
  const s = steps(async () => ({ txHash: "" }), {
    submitProve: async () => {
      submits += 1;
      return { status: "running" };
    },
    pollProve: async () => ({ status: "error", error: "base rpc: eth_getProof timed out" }),
  });

  await runBaseShieldTick(store, CFG, s);
  let state = await jobState(store, job.id);
  assert.equal(state.status, "proving", "first error does not kill the job");
  assert.equal(state.attempts, 1);

  await runBaseShieldTick(store, CFG, s);
  state = await jobState(store, job.id);
  assert.equal(state.status, "proving");
  assert.equal(state.attempts, 2);
  assert.equal(submits, 2, "each tick resubmits (a fresh run after a service-side error)");

  // Third error hits PROVE_MAX_ATTEMPTS -> terminal.
  await runBaseShieldTick(store, CFG, s);
  state = await jobState(store, job.id);
  assert.equal(state.status, "failed");
  assert.match(state.error, /prove: .*timed out/);
});

test("a thrown submitProve (prove service unreachable) is counted, visible, and capped", async () => {
  const { store, job } = await storeWithJob();

  let submits = 0;
  const s = steps(async () => ({ txHash: "" }), {
    submitProve: async () => {
      submits += 1;
      throw new Error("prove submit failed: 503 service unavailable");
    },
  });

  await runBaseShieldTick(store, CFG, s);
  let state = await jobState(store, job.id);
  assert.equal(state.status, "proving", "a transport failure keeps the job in its stage");
  assert.equal(state.attempts, 1, "the failure is counted");
  assert.match(state.error, /proving: .*503/, "the failure is persisted for list_base_shields");

  // The generous transport cap is still finite: a permanently-failing job goes terminal instead
  // of head-of-line-blocking its stage forever.
  for (let i = 1; i < TRANSPORT_MAX_ATTEMPTS; i += 1) await runBaseShieldTick(store, CFG, s);
  state = await jobState(store, job.id);
  assert.equal(state.status, "failed");
  assert.match(state.error, /proving: .*503/);
  assert.equal(submits, TRANSPORT_MAX_ATTEMPTS);
});

test("a thrown isFinalized (Base RPC unreachable) is counted against the transport cap", async () => {
  const { store, job } = await storeWithJob();
  await store.baseShieldProved(job.id, 42, "cd".repeat(32), "aa", "bb", true);

  const s = steps(async () => ({ txHash: "" }), {
    isFinalized: async () => {
      throw new Error("base rpc finalized query failed: 502");
    },
  });
  await runBaseShieldTick(store, CFG, s);

  const state = await jobState(store, job.id);
  assert.equal(state.status, "awaiting_finality");
  assert.equal(state.attempts, 1);
  assert.match(state.error, /awaiting_finality: .*502/);
});

test("a prove success after transient errors advances the job and resets the counter", async () => {
  const { store, job } = await storeWithJob();

  let polls = 0;
  const s = steps(async () => ({ txHash: "" }), {
    pollProve: async () => {
      polls += 1;
      return polls < 3 ? { status: "error", error: "flake" } : PROVED;
    },
  });
  await runBaseShieldTick(store, CFG, s);
  await runBaseShieldTick(store, CFG, s);
  await runBaseShieldTick(store, CFG, s);

  const state = await jobState(store, job.id);
  assert.equal(state.status, "minting");
  assert.equal(state.attempts, 0, "stage transition clears the counter");
  assert.equal(state.error, null);
});
