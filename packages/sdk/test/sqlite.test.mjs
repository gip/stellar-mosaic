// SqliteStore round-trip over NoteManager (the durable store the CLI/agent uses). In-memory db.
import test from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../dist/node.js";
import { NoteManager } from "../dist/index.js";

const note = (over) => ({
  id: crypto.randomUUID(),
  deskId: "d",
  role: "asset",
  asset_id: 1,
  symbol: "X",
  amount: "100",
  sk: "0x1",
  rho: "0x2",
  owner_tag: "0xabc",
  status: "active",
  indexed: false,
  createdAt: 1,
  ...over,
});

test("SqliteStore persists, queries by desk, updates, and deletes", async () => {
  const m = new NoteManager(new SqliteStore(":memory:"));
  const a = note({ deskId: "d", amount: "100" });
  const b = note({ deskId: "other", amount: "50" });
  await m.add(a);
  await m.add(b);

  const d = await m.forDesk("d");
  assert.equal(d.length, 1);
  assert.equal(d[0].id, a.id);
  assert.equal(d[0].amount, "100");

  await m.update(a.id, { amount: "250" });
  assert.equal((await m.forDesk("d"))[0].amount, "250");

  await m.remove(a.id);
  assert.equal((await m.forDesk("d")).length, 0);
  assert.equal((await m.forDesk("other")).length, 1);
});
