// Unit tests for the Base-shield client steps: journal parsing, the direct JSON-RPC finality check,
// and the submit/poll prove-service client. Network is stubbed via a fake global fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { parseJournalBlock, isFinalized, submitProve, pollProve } from "../dist/baseShield.js";

const CFG = {
  proveServiceUrl: "https://prover.example",
  proveToken: "tok",
  baseRpc: "https://base.example",
  stellar: { rpcUrl: "https://soroban.example", networkPassphrase: "Test SDF Network ; September 2015" },
};

function withFetch(fn, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return typeof body === "function" ? body({ url, init }) : body;
      },
      async text() {
        return JSON.stringify(body);
      },
    };
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = original;
  });
}

test("parseJournalBlock reads word 0 (number) and word 1 (hash)", () => {
  const journal = Buffer.alloc(256);
  journal.writeBigUInt64BE(0x1234n, 24);
  journal.fill(0xab, 32, 64);
  const { blockNumber, blockHash } = parseJournalBlock(journal);
  assert.equal(blockNumber, 0x1234);
  assert.equal(blockHash, "ab".repeat(32));
  assert.throws(() => parseJournalBlock(Buffer.alloc(100)), /256 bytes/);
});

test("isFinalized compares the finalized block number", async () => {
  await withFetch(
    async () => {
      assert.equal(await isFinalized(CFG.baseRpc, 40), true);
      assert.equal(await isFinalized(CFG.baseRpc, 42), true);
      assert.equal(await isFinalized(CFG.baseRpc, 43), false);
    },
    { result: { number: "0x2a" } }, // 42
  );
});

test("submitProve POSTs the job with a bearer token and returns the status", async () => {
  await withFetch(
    async (calls) => {
      const result = await submitProve(CFG, { jobId: "job-1", bridge: "0xbridge", depositId: 5 });
      assert.deepEqual(result, { status: "running" });
      assert.equal(calls[0].url, "https://prover.example/prove/base-deposit");
      assert.equal(calls[0].init.method, "POST");
      assert.equal(calls[0].init.headers.authorization, "Bearer tok");
      assert.deepEqual(JSON.parse(calls[0].init.body), { job_id: "job-1", bridge: "0xbridge", deposit_id: 5 });
    },
    { status: "running" },
  );
});

test("pollProve GETs by job id and surfaces done artifacts", async () => {
  await withFetch(
    async (calls) => {
      const result = await pollProve(CFG, "job-1");
      assert.equal(result.status, "done");
      assert.equal(result.block_number, 42);
      assert.equal(calls[0].url, "https://prover.example/prove/base-deposit/job-1");
      assert.equal(calls[0].init?.headers?.authorization, "Bearer tok");
    },
    { status: "done", seal_hex: "aa", journal_hex: "bb", block_number: 42, block_hash: "cd" },
  );
});

test("prove client throws on a non-ok HTTP status", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, async text() { return "unavailable"; } });
  try {
    await assert.rejects(() => pollProve(CFG, "job-1"), /503/);
  } finally {
    globalThis.fetch = original;
  }
});
