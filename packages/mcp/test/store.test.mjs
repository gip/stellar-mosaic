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
