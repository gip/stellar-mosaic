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

const BASE_BRIDGE = "0xabababababababababababababababababababab";

async function insertBaseDesk(store) {
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
}

async function assertBaseShieldLifecycle(store) {
  await insertBaseDesk(store);
  const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

  // Drift guard: a bridge that isn't the desk's configured one is rejected.
  await assert.rejects(() => store.enqueueBaseShield("desk-base", "0xdead", 1, address), /bridge mismatch/);
  // Unknown desk is rejected too.
  await assert.rejects(() => store.enqueueBaseShield("nope", BASE_BRIDGE, 1, address), /not found|no configured/);

  const deposit = { asset_id: 2, symbol: "USDC", decimals: 6, amount: "100000", base_tx_hash: "0x" + "ab".repeat(32) };
  const job = await store.enqueueBaseShield("desk-base", BASE_BRIDGE, 7, address, deposit);
  assert.equal(job.status, "proving");
  // Display metadata from the depositing client is persisted so the mint leg can render a complete
  // Activity entry even without the local deposit event.
  assert.deepEqual(job.deposit, deposit);
  // Idempotent enqueue returns the same job (metadata intact).
  const again = await store.enqueueBaseShield("desk-base", BASE_BRIDGE, 7, address);
  assert.equal(again.id, job.id);
  assert.deepEqual(again.deposit, deposit);
  assert.deepEqual((await store.listBaseShields("desk-base", address)).find((j) => j.id === job.id).deposit, deposit);

  const next = await store.nextBaseShields();
  assert.equal(next.length, 1);
  assert.equal(next[0].id, job.id, "proving job is picked up");

  await store.baseShieldProved(job.id, 42, "cd".repeat(32), "aa", "bb", true);
  const proved = (await store.listBaseShields("desk-base", address)).find((j) => j.id === job.id);
  assert.equal(proved.status, "awaiting_finality");
  assert.equal(proved.block_number, 42);
  assert.equal(proved.block_hash, "cd".repeat(32));
  assert.equal(proved.seal_hex, "aa");
  assert.equal(proved.journal_hex, "bb");

  await store.baseShieldStatus(job.id, "minting");
  assert.equal((await store.nextBaseShields())[0].status, "minting");
  await store.baseShieldRelease(job.id);

  // Pipelining: the minting job must not block newer jobs' proving. With A minting and B, C both
  // proving, the per-tick batch is oldest-per-stage: [B (proving), A (minting)] — never C.
  const jobB = await store.enqueueBaseShield("desk-base", BASE_BRIDGE, 9, address);
  const jobC = await store.enqueueBaseShield("desk-base", BASE_BRIDGE, 10, address);
  const batch = await store.nextBaseShields();
  assert.deepEqual(
    batch.map((j) => [j.id, j.status]),
    [
      [jobB.id, "proving"],
      [job.id, "minting"],
    ],
    "oldest job per stage, in stage order",
  );
  await store.baseShieldFailed(jobB.id, "cleanup");
  assert.equal((await store.nextBaseShields()).find((j) => j.status === "proving").id, jobC.id, "next-oldest proving job takes over");
  await store.baseShieldFailed(jobC.id, "cleanup");

  await store.baseShieldStatus(job.id, "active", "ef".repeat(32));
  assert.deepEqual(await store.nextBaseShields(), [], "terminal jobs are not picked up");
  const minted = (await store.listBaseShields("desk-base", address)).find((j) => j.id === job.id);
  assert.equal(minted.stellar_tx_hash, "ef".repeat(32), "mint tx hash is persisted for the UI");

  // A second job can fail and reports its message.
  const job2 = await store.enqueueBaseShield("desk-base", BASE_BRIDGE, 8, address);
  await store.baseShieldFailed(job2.id, "boom");
  const failed = (await store.listBaseShields("desk-base", address)).find((j) => j.id === job2.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "boom");
  assert.deepEqual(await store.nextBaseShields(), []);
}

test("memory MCP store advances base-shield jobs and guards bridge drift", async () => {
  await assertBaseShieldLifecycle(new MemoryMosaicStore());
});

test("sqlite MCP store advances base-shield jobs and guards bridge drift", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mosaic-mcp-store-"));
  await assertBaseShieldLifecycle(openMosaicStore(`sqlite://${join(dir, "mcp.db")}`));
});

test("sqlite MCP store atomically claims one client action across two handles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mosaic-mcp-store-"));
  const url = `sqlite://${join(dir, "mcp.db")}`;
  const a = openMosaicStore(url);
  const b = openMosaicStore(url);
  const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  await a.createOperation(address, "testnet", { kind: "shield", desk_id: "desk-1", asset_id: 1, amount: "1" }, "same-op");

  const [first, second] = await Promise.all([a.claimAction(address), b.claimAction(address)]);
  assert.equal([first, second].filter(Boolean).length, 1);
});

test("sqlite MCP store preserves operation idempotency across two handles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mosaic-mcp-store-"));
  const url = `sqlite://${join(dir, "mcp.db")}`;
  const a = openMosaicStore(url);
  const b = openMosaicStore(url);
  const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const request = { kind: "shield", desk_id: "desk-1", asset_id: 1, amount: "1" };

  const [one, two] = await Promise.all([a.createOperation(address, "testnet", request, "idem"), b.createOperation(address, "testnet", request, "idem")]);
  assert.equal(one.id, two.id);
  assert.equal((await a.listOperations(address)).length, 1);
});

test("sqlite MCP store backup writes are generation-CAS and reads require auth material", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mosaic-mcp-store-"));
  const url = `sqlite://${join(dir, "mcp.db")}`;
  const a = openMosaicStore(url);
  const b = openMosaicStore(url);
  const envelope = { format_version: 1, generation: 0, nonce_b64: "bm9uY2U=", ciphertext_b64: "Y2lwaGVy" };

  await a.putWalletBackup("backup-1", "write", "read", 0, envelope);
  await assert.rejects(() => b.putWalletBackup("backup-1", "write", "read", 0, envelope), /generation conflict/);
  await assert.rejects(() => b.getWalletBackupForRead("backup-1"), /read token|auth/i);
  await assert.rejects(() => b.getWalletBackupForRead("backup-1", "wrong"), /read token mismatch/);
  assert.equal((await b.getWalletBackupForRead("backup-1", "read")).generation, 1);
});

test("sqlite MCP store claims each base-shield job once across two workers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mosaic-mcp-store-"));
  const url = `sqlite://${join(dir, "mcp.db")}`;
  const a = openMosaicStore(url);
  const b = openMosaicStore(url);
  const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  await insertBaseDesk(a);
  const job = await a.enqueueBaseShield("desk-base", BASE_BRIDGE, 77, address);

  const first = await a.nextBaseShields();
  const second = await b.nextBaseShields();
  assert.deepEqual(first.map((j) => j.id), [job.id]);
  assert.deepEqual(second, []);
  await a.baseShieldRelease(job.id);
  assert.deepEqual((await b.nextBaseShields()).map((j) => j.id), [job.id]);
});
