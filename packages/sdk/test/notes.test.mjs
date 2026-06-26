// NoteManager lifecycle tests over the in-memory store: legacy normalization, LWW recovery merge,
// and on-chain reconciliation by owner_tag.
import test from "node:test";
import assert from "node:assert/strict";
import { NoteManager, MemoryStore, normalizeNote, mergeNote } from "../dist/index.js";

const note = (over) => ({
  id: "n1",
  deskId: "d",
  role: "asset",
  asset_id: 1,
  symbol: "X",
  amount: "100",
  sk: "0x1",
  rho: "0x2",
  owner_tag: "0xABC",
  status: "active",
  indexed: false,
  createdAt: 1,
  ...over,
});

test("normalizeNote maps legacy pending/confirmed onto status+indexed", () => {
  // Real legacy records predate the `indexed` field, so omit it (the `?? confirmed` fallback only
  // applies when indexed is absent).
  const legacy = (over) => {
    const n = note(over);
    delete n.indexed;
    return n;
  };
  assert.equal(normalizeNote(legacy({ status: "confirmed" })).indexed, true);
  assert.equal(normalizeNote(legacy({ status: "confirmed" })).status, "active");
  assert.equal(normalizeNote(legacy({ status: "pending" })).indexed, false);
  assert.equal(normalizeNote(legacy({ cancelledAt: 5 })).status, "cancelled");
});

test("add/update bumps revision and forDesk scopes by wallet", async () => {
  const m = new NoteManager(new MemoryStore());
  await m.add(note({ id: "a", wallet_address: "GA", recovery_version: 1 }));
  await m.add(note({ id: "b", wallet_address: "GB", recovery_version: 1 }));
  const forGA = await m.forDesk("d", "GA");
  assert.deepEqual(forGA.map((n) => n.id), ["a"]);

  await m.update("a", { amount: "250" });
  const a = (await m.forDesk("d", "GA"))[0];
  assert.equal(a.amount, "250");
  assert.equal(a.revision, 2); // add() -> 1, update() -> 2
});

test("mergeNote is last-write-wins with monotonic terminal status + indexed", () => {
  const base = note({ revision: 1, updatedAt: 10, indexed: false, status: "active" });
  const newer = note({ revision: 2, updatedAt: 20, amount: "999", indexed: false });
  const spentStale = note({ revision: 1, updatedAt: 5, status: "spent", indexed: true });
  const m1 = mergeNote(base, newer);
  assert.equal(m1.amount, "999");
  assert.equal(m1.revision, 2);
  // A terminal status anywhere wins; indexed is OR-ed.
  const m2 = mergeNote(newer, spentStale);
  assert.equal(m2.status, "spent");
  assert.equal(m2.indexed, true);
});

test("reconcile stamps leaf_index + indexed + on-chain amount, skips cancelled", async () => {
  const m = new NoteManager(new MemoryStore());
  await m.add(note({ id: "live", owner_tag: "0xAbC", indexed: false, amount: "0" }));
  await m.add(note({ id: "cancelled", owner_tag: "0xDEF", status: "cancelled" }));
  const changed = await m.reconcile("d", [
    { leaf_index: 7, asset: 1, amount: "100", owner_tag: "0xabc" },
    { leaf_index: 9, asset: 1, amount: "55", owner_tag: "0xdef" },
  ]);
  assert.equal(changed, true);
  const all = await m.forDesk("d");
  const live = all.find((n) => n.id === "live");
  assert.equal(live.indexed, true);
  assert.equal(live.leaf_index, 7);
  assert.equal(live.amount, "100"); // estimate replaced by on-chain amount
  const cancelled = all.find((n) => n.id === "cancelled");
  assert.equal(cancelled.leaf_index, undefined); // cancelled notes are skipped
});
