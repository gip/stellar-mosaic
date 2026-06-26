// No-network smoke test for MosaicClient wiring: the `assemble` direct/impossible paths run purely
// over the NoteManager + planAssembly, touching no signer/submitter/source/circuits. This verifies
// the client composes the extracted pieces correctly. Full proving/submit flows are covered by the
// CLI e2e against testnet (Phase 6).
import test from "node:test";
import assert from "node:assert/strict";
import { MosaicClient, MemoryStore, StaticDeskProvider } from "../dist/index.js";

const desk = {
  id: "d",
  contractId: "CCCC",
  assets: [{ asset_id: 1, symbol: "X", token: null, decimals: 0, kind: "Stellar" }],
  pairs: [],
};

function makeClient() {
  const store = new MemoryStore();
  const ports = {
    network: { rpcUrl: "", networkPassphrase: "" },
    signer: {},
    store,
    source: {},
    submitter: {},
    desks: new StaticDeskProvider([desk]),
    circuits: () => {
      throw new Error("circuits should not be used by direct assemble");
    },
  };
  return new MosaicClient(ports);
}

const note = (over) => ({
  id: crypto.randomUUID(),
  deskId: "d",
  role: "asset",
  asset_id: 1,
  symbol: "X",
  amount: "100",
  sk: "0x1",
  rho: "0x2",
  owner_tag: "0x3",
  status: "active",
  indexed: true,
  createdAt: 0,
  ...over,
});

test("assemble returns an existing exact note directly (no network)", async () => {
  const c = makeClient();
  const n = note({ amount: "100" });
  await c.noteManager.add(n);
  const { note: got } = await c.assemble("d", 1, "100");
  assert.equal(got.id, n.id);
  assert.equal(got.amount, "100");
});

test("assemble throws when balance is insufficient", async () => {
  const c = makeClient();
  await c.noteManager.add(note({ amount: "10" }));
  await assert.rejects(() => c.assemble("d", 1, "999"), /exceeds/);
});

test("shieldFromBase errors clearly without an MCP", async () => {
  const c = makeClient();
  await assert.rejects(
    () => c.shieldFromBase({ deskId: "d", asset_id: 1, amount: "1", baseTxHash: "0x0" }),
    /requires an MCP/,
  );
});
