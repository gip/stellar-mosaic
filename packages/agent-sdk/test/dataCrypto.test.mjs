// sealAgentData/openAgentData: E2E encryption of attached/scratch values under the agent dataKey.

import test from "node:test";
import assert from "node:assert/strict";
import { sealAgentData, openAgentData, isSealedData } from "../dist/portable.js";

test("seal/open roundtrips arbitrary JSON", async () => {
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const value = { instructions: "buy low", limits: { maxOrder: "100000000" }, tags: ["a", "b"] };
  const sealed = await sealAgentData(value, dataKey);
  assert.ok(isSealedData(sealed));
  assert.ok(!JSON.stringify(sealed).includes("buy low"));
  assert.deepEqual(await openAgentData(sealed, dataKey), value);
});

test("wrong key and tampering are rejected", async () => {
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const sealed = await sealAgentData({ secret: 1 }, dataKey);
  await assert.rejects(openAgentData(sealed, crypto.getRandomValues(new Uint8Array(32))), /failed to open/);
  const tampered = { ...sealed, ct: sealed.ct.slice(0, -2) + (sealed.ct.endsWith("00") ? "01" : "00") };
  await assert.rejects(openAgentData(tampered, dataKey), /failed to open/);
});

test("isSealedData distinguishes plain values", () => {
  assert.equal(isSealedData({ mosaic_sealed: 1, nonce: "00", ct: "00" }), true);
  assert.equal(isSealedData({ plain: true }), false);
  assert.equal(isSealedData("str"), false);
  assert.equal(isSealedData(null), false);
});
