import test from "node:test";
import assert from "node:assert/strict";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { ChainEventSource, MemoryStore, parseLedgerRange } from "../dist/index.js";

const network = { rpcUrl: "https://example.invalid", networkPassphrase: "Test SDF Network ; September 2015" };

test("parseLedgerRange extracts Soroban RPC retained range", () => {
  assert.deepEqual(
    parseLedgerRange("startLedger must be within the ledger range: 3176067 - 3297026"),
    { oldest: 3176067, latest: 3297026 },
  );
  assert.equal(parseLedgerRange("not a range"), null);
});

test("ChainEventSource resumes from cached cursor", async () => {
  const calls = [];
  const cache = {
    async load() {
      return {
        cursor: "cursor-1",
        treeEvents: [{ kind: "shielded", asset: 1, amount: "1", owner_tag: "0x" + "01".padStart(64, "0") }],
        fills: [],
        latestLedger: 10,
      };
    },
    async save() {},
  };
  const source = new ChainEventSource({
    network,
    cache,
    server: {
      async getEvents(request) {
        calls.push(request);
        assert.equal(request.cursor, "cursor-1");
        return { events: [], cursor: "cursor-2", latestLedger: 11 };
      },
    },
  });
  const events = await source.events("C", 1);
  assert.equal(events.length, 1);
  assert.equal(calls.length, 1);
});

test("ChainEventSource salvages from oldest retained ledger when replay validates", async () => {
  const calls = [];
  const source = new ChainEventSource({
    network,
    server: {
      async getEvents(request) {
        calls.push(request);
        if (request.startLedger === 1) {
          throw new Error("startLedger must be within the ledger range: 5 - 9");
        }
        assert.equal(request.startLedger, 5);
        return { events: [], cursor: "cursor-5", latestLedger: 9 };
      },
    },
  });
  await source.events("C", 1, { validateReplay: async (events) => assert.equal(events.length, 0) });
  assert.equal(calls.length, 2);
});

test("ChainEventSource refuses salvage when retained replay does not validate", async () => {
  const saved = [];
  const source = new ChainEventSource({
    network,
    cache: {
      async load() {
        return undefined;
      },
      async save(_scope, snapshot) {
        saved.push(snapshot);
      },
    },
    server: {
      async getEvents(request) {
        if (request.startLedger === 1) {
          throw new Error("startLedger must be within the ledger range: 5 - 9");
        }
        return { events: [], cursor: "cursor-5", latestLedger: 9 };
      },
    },
  });
  await assert.rejects(
    source.events("C", 1, { validateReplay: async () => { throw new Error("root mismatch"); } }),
    /trustless note history unavailable/,
  );
  assert.match(saved.at(-1)?.fatalError ?? "", /root mismatch/);
});

const tag = (n) => Buffer.from("0".repeat(63) + n, "hex");
const symbol = (value) => xdr.ScVal.scvSymbol(value);
const event = (id, topic, value, txHash = "tx") => ({ id, ledger: 9, txHash, topic: [symbol(topic)], value });

test("ChainEventSource records every contract event and parsed fills", async () => {
  const activity = new MemoryStore();
  const shielded = event(
    "1",
    "shielded",
    xdr.ScVal.scvVec([
      nativeToScVal(1, { type: "u32" }),
      nativeToScVal(100n, { type: "i128" }),
      xdr.ScVal.scvBytes(tag(1)),
    ]),
  );
  const filled = event(
    "2",
    "filled",
    xdr.ScVal.scvVec([
      nativeToScVal(1, { type: "u32" }),
      nativeToScVal(100n, { type: "i128" }),
      nativeToScVal(2, { type: "u32" }),
      nativeToScVal(50n, { type: "i128" }),
      xdr.ScVal.scvBytes(tag(2)),
    ]),
    "tx-fill",
  );
  const source = new ChainEventSource({
    network,
    activity,
    server: {
      async getEvents() {
        return { events: [shielded, filled], cursor: "c", latestLedger: 10 };
      },
    },
  });

  const events = await source.events("C", 1);
  assert.equal(events.length, 1);
  assert.equal((await activity.list({ kind: "contract_event" })).length, 2);
  const fills = await activity.list({ kind: "fill" });
  assert.equal(fills.length, 1);
  assert.equal(fills[0].tx_hash, "tx-fill");

  await source.events("C", 1);
  assert.equal((await activity.list({ kind: "contract_event" })).length, 2);
});
