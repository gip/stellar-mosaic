import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryMosaicStore, openMosaicStore } from "../dist/store.js";

test("sqlite MCP store persists desks, sponsor custody, and sessions across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mosaic-mcp-store-"));
  const url = `sqlite://${join(dir, "mcp.db")}`;
  const first = openMosaicStore(url);
  const desk = {
    id: "desk-1",
    name: "Desk 1",
    contract_id: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    sponsor_pubkey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    event_start_ledger: 123,
    assets: [],
    pairs: [],
    base_deployment: null,
  };
  await first.insertDesk(desk, "SA_SPONSOR_SECRET");
  const created = await first.createSession("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "testnet");

  const reopened = openMosaicStore(url);
  assert.equal((await reopened.getDesk("desk-1")).contract_id, desk.contract_id);
  assert.equal(await reopened.sponsorSecret("desk-1"), "SA_SPONSOR_SECRET");
  assert.equal((await reopened.getSession(created.token))?.address, desk.sponsor_pubkey);
});

async function assertCompletedActionIsNotReclaimed(store) {
  const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const request = { kind: "shield", desk_id: "desk-1", asset_id: 1, amount: "10000000" };
  await store.createOperation(address, "testnet", request, "shield-once");
  const action = await store.claimAction(address);
  assert.ok(action, "expected initial action lease");

  await store.completeAction(address, action.id, action.lease_token, { transaction: "SUCCESS abc" });

  const realNow = Date.now;
  Date.now = () => realNow() + 120_000;
  try {
    assert.equal(await store.claimAction(address), null);
  } finally {
    Date.now = realNow;
  }
}

test("memory MCP store does not reclaim completed actions after lease expiry", async () => {
  await assertCompletedActionIsNotReclaimed(new MemoryMosaicStore());
});

test("sqlite MCP store does not reclaim completed actions after lease expiry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mosaic-mcp-store-"));
  await assertCompletedActionIsNotReclaimed(openMosaicStore(`sqlite://${join(dir, "mcp.db")}`));
});

async function assertActivityPersistence(store) {
  const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const other = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBR5";
  const first = await store.recordActivity(address, "testnet", [
    {
      id: "activity-1",
      idempotency_key: "idem-1",
      kind: "transaction",
      wallet_address: other,
      network: "public",
      status: "submitted",
      created_at: 100,
      metadata: { proof: "secret-proof", nested: { tx_xdr: "secret-xdr", kept: "ok" } },
    },
  ]);
  assert.equal(first.length, 1);
  assert.equal(first[0].cursor, 1);
  assert.equal(first[0].wallet_address, address);
  assert.equal(first[0].network, "testnet");
  assert.equal(first[0].metadata.proof, undefined);
  assert.equal(first[0].metadata.nested.tx_xdr, undefined);
  assert.equal(first[0].metadata.nested.kept, "ok");

  const duplicate = await store.recordActivity(address, "testnet", [
    { id: "activity-1-retry", idempotency_key: "idem-1", kind: "transaction", status: "succeeded" },
  ]);
  assert.equal(duplicate[0].cursor, first[0].cursor);
  assert.equal(duplicate[0].id, "activity-1");
  assert.equal(duplicate[0].status, "submitted");

  const second = await store.recordActivity(address, "testnet", [
    { id: "activity-2", kind: "error", created_at: 200 },
  ]);
  assert.ok(second[0].cursor > first[0].cursor);

  await store.recordActivity(address, "public", [{ id: "activity-1", kind: "transaction", created_at: 300 }]);
  await store.recordActivity(other, "testnet", [{ id: "activity-1", kind: "transaction", created_at: 400 }]);

  assert.deepEqual((await store.activityAfter(address, "testnet", 0)).map((event) => event.id), ["activity-1", "activity-2"]);
  assert.deepEqual((await store.activityAfter(address, "testnet", first[0].cursor)).map((event) => event.id), ["activity-2"]);
  assert.deepEqual((await store.activityAfter(address, "public", 0)).map((event) => event.id), ["activity-1"]);
  assert.deepEqual((await store.activityAfter(other, "testnet", 0)).map((event) => event.id), ["activity-1"]);
}

test("memory MCP store records scoped sanitized activity", async () => {
  await assertActivityPersistence(new MemoryMosaicStore());
});

test("sqlite MCP store records scoped sanitized activity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mosaic-mcp-store-"));
  await assertActivityPersistence(openMosaicStore(`sqlite://${join(dir, "mcp.db")}`));
});
