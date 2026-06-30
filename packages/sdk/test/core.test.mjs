// Pure-logic tests for the ported amount + order-planning modules (no network, no crypto).
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAmount,
  toRaw,
  formatAmount,
  parseRatio,
  computeMinOutAtPrice,
  planAssembly,
  spendableNotes,
  maxIn,
} from "../dist/index.js";

test("amount: parse/format round-trips and decimal handling", () => {
  assert.equal(parseAmount("1.5", 7), 15000000n);
  assert.equal(toRaw("2", 7), "20000000");
  assert.equal(formatAmount("15000000", 7), "1.5");
  assert.equal(formatAmount("20000000", 7), "2");
  assert.throws(() => parseAmount("1.23456789", 7)); // too many decimals
  const r = parseRatio("0.12");
  assert.equal(r.num, 12n);
  assert.equal(r.den, 100n);
});

test("amount: computeMinOutAtPrice direction differs per side", () => {
  // price = 2 quote per base, zero decimals on both sides.
  assert.equal(computeMinOutAtPrice(5n, "2", "SELL", 0, 0), 10n); // base*price
  assert.equal(computeMinOutAtPrice(5n, "2", "BUY", 0, 0), 2n); // base = quote/price (floor)
});

const note = (over) => ({
  id: "x",
  deskId: "d",
  role: "asset",
  asset_id: 1,
  symbol: "X",
  amount: "100",
  sk: "0x0",
  rho: "0x0",
  owner_tag: "0x0",
  status: "active",
  indexed: true,
  createdAt: 0,
  ...over,
});

test("orderPlan: direct / split / join / impossible", () => {
  const direct = planAssembly([note({ id: "a", amount: "100" })], 1, 100n);
  assert.deepEqual(direct, { kind: "direct", noteId: "a" });

  const split = planAssembly([note({ id: "a", amount: "250" })], 1, 100n);
  assert.equal(split.kind, "assemble");
  assert.equal(split.steps[0].op, "split");
  assert.equal(split.steps[0].changeRaw, "150");

  const join = planAssembly(
    [note({ id: "a", amount: "60" }), note({ id: "b", amount: "70" })],
    1,
    100n,
  );
  assert.equal(join.kind, "assemble");
  const last = join.steps[join.steps.length - 1];
  assert.equal(last.op, "join");
  assert.equal(last.targetRaw, "100");
  assert.equal(last.changeRaw, "30"); // 70 + 60 - 100

  const impossible = planAssembly([note({ amount: "10" })], 1, 1000n);
  assert.equal(impossible.kind, "impossible");
});

test("orderPlan: spendable excludes unindexed/reserved/spent/other-asset", () => {
  const notes = [
    note({ id: "ok", amount: "100" }),
    note({ id: "unindexed", indexed: false }),
    note({ id: "reserved", operation_state: "reserved" }),
    note({ id: "spent", status: "spent" }),
    note({ id: "other", asset_id: 2 }),
  ];
  const sp = spendableNotes(notes, 1);
  assert.deepEqual(
    sp.map((n) => n.id),
    ["ok"],
  );
  assert.equal(maxIn(notes, 1), 100n);
});
