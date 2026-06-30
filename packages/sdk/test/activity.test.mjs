import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../dist/index.js";
import { SqliteStore } from "../dist/node.js";

async function exerciseStore(store) {
  const first = await store.record({
    kind: "user_action",
    action: "shield",
    status: "started",
    wallet_address: "GA",
    desk_id: "d",
    idempotency_key: "once",
    metadata: { amount: "10", sk: "secret", proof: "bytes" },
  });
  const duplicate = await store.record({
    kind: "user_action",
    action: "shield",
    status: "started",
    wallet_address: "GA",
    desk_id: "d",
    idempotency_key: "once",
  });
  const tx = await store.record({
    kind: "transaction",
    status: "succeeded",
    wallet_address: "GB",
    desk_id: "other",
    tx_hash: "tx1",
  });

  assert.equal(duplicate.cursor, first.cursor);
  assert.equal((await store.list()).length, 2);
  assert.deepEqual((await store.list({ walletAddress: "GA" })).map((e) => e.cursor), [first.cursor]);
  assert.deepEqual((await store.list({ txHash: "tx1" })).map((e) => e.cursor), [tx.cursor]);
  assert.deepEqual((await store.since(first.cursor)).map((e) => e.cursor), [tx.cursor]);
  assert.equal("sk" in first.metadata, false);
  assert.equal("proof" in first.metadata, false);
}

test("MemoryStore records, filters, orders, and dedupes activity", async () => {
  await exerciseStore(new MemoryStore());
});

test("SqliteStore persists activity with filtering and dedupe", async () => {
  const store = new SqliteStore(":memory:");
  await exerciseStore(store);
});
