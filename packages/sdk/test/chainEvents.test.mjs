import test from "node:test";
import assert from "node:assert/strict";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { ChainEventSource, MemoryStore, parseLedgerRange, parseLedgerRangeError } from "../dist/index.js";

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

test("ChainEventSource recovers when a cached cursor has aged out of retention", async () => {
  // Regression: a persistent cache can resume from a cursor whose ledger the RPC no longer retains.
  // getEvents({cursor}) then throws a ledger-range error; the source must drop the stale cursor and
  // rebuild from the oldest retained ledger instead of rethrowing (which left notes "pending index").
  const calls = [];
  const stale = { kind: "shielded", asset: 1, amount: "1", owner_tag: "0x" + "01".padStart(64, "0") };
  const fresh = event(
    "f",
    "shielded",
    xdr.ScVal.scvVec([
      nativeToScVal(2, { type: "u32" }),
      nativeToScVal(5n, { type: "i128" }),
      xdr.ScVal.scvBytes(tag(2)),
    ]),
  );
  const cache = {
    async load() {
      return { cursor: "stale-cursor", treeEvents: [stale], fills: [], latestLedger: 4 };
    },
    async save() {},
  };
  const source = new ChainEventSource({
    network,
    cache,
    server: {
      async getEvents(request) {
        calls.push(request);
        if (request.cursor === "stale-cursor") {
          throw new Error("startLedger must be within the ledger range: 5 - 9");
        }
        assert.equal(request.startLedger, 5);
        return { events: [fresh], cursor: "cursor-9", latestLedger: 9 };
      },
    },
  });
  // The replayed retained window is authoritative (it reaches genesis), so validation passes and the
  // result reflects only the freshly-fetched events, not the discarded stale one.
  const events = await source.events("C", 1, { validateReplay: async () => {} });
  assert.deepEqual(events, [{ kind: "shielded", asset: 2, amount: "5", owner_tag: "0x" + "02".padStart(64, "0") }]);
  assert.equal(calls.length, 2);
});

test("ChainEventSource clamps to head when start ledger leads the RPC, parsing a plain RPC error", async () => {
  // Regression: right after desk creation getLatestLedger() can lead getEvents by a ledger, and the
  // RPC rejects with a JSON-RPC *object* { code, message } (not an Error). The source must still
  // parse the range, recognise "ahead of head", and retry at the head instead of rethrowing.
  const calls = [];
  const source = new ChainEventSource({
    network,
    server: {
      async getEvents(request) {
        calls.push(request);
        if (request.startLedger === 12) {
          throw { code: -32600, message: "startLedger must be within the ledger range: 5 - 9" };
        }
        assert.equal(request.startLedger, 9);
        return { events: [], cursor: "cursor-9", latestLedger: 9 };
      },
    },
  });
  const events = await source.events("C", 12);
  assert.deepEqual(events, []);
  assert.equal(calls.length, 2); // ahead-of-head retry does NOT need a retained-window validator
});

test("parseLedgerRangeError reads a plain JSON-RPC error object", () => {
  assert.deepEqual(
    parseLedgerRangeError({ code: -32600, message: "startLedger must be within the ledger range: 5 - 9" }),
    { oldest: 5, latest: 9 },
  );
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

const shieldEvent = (n) =>
  event("e" + n, "shielded", xdr.ScVal.scvVec([
    nativeToScVal(1, { type: "u32" }),
    nativeToScVal(BigInt(n), { type: "i128" }),
    xdr.ScVal.scvBytes(tag(n)),
  ]));

test("ChainEventSource serializes concurrent reads so a fetched page is not double-appended", async () => {
  // Regression: many callers (order flow, note/fill polls, reconcile) hit events() concurrently.
  // Without per-contract serialization they interleave inside fetchPages and each push the same new
  // page into the shared accumulator, producing duplicate leaves and a replay root that never
  // existed on-chain. The getEvents delay forces the interleave the real RPC exposes.
  let phase = "initial";
  const source = new ChainEventSource({
    network,
    server: {
      async getEvents(request) {
        await new Promise((r) => setTimeout(r, 5));
        if (request.startLedger !== undefined) {
          return { events: [shieldEvent(1), shieldEvent(2)], cursor: "c1", latestLedger: 10 };
        }
        if (request.cursor === "c1" && phase === "new") {
          return { events: [shieldEvent(3)], cursor: "c2", latestLedger: 11 };
        }
        return { events: [], cursor: request.cursor, latestLedger: 11 };
      },
    },
  });
  await source.events("C", 1); // establish state: acc=[e1,e2], cursor c1
  phase = "new";
  const [a, b] = await Promise.all([source.events("C", 1), source.events("C", 1)]);
  assert.equal(a.length, 3, "expected e1,e2,e3 with no duplicate");
  assert.equal(b.length, 3);
});

test("ChainEventSource rebuilds instead of duplicating when a cached snapshot has events but no cursor", async () => {
  // Regression: a snapshot persisted with events but a falsy cursor would resume from startLedger on
  // top of the cached acc and duplicate every leaf. The source must rebuild from scratch instead.
  const cache = {
    async load() {
      return { cursor: undefined, treeEvents: [{ kind: "shielded", asset: 1, amount: "1", owner_tag: "0x" + "01".padStart(64, "0") }], fills: [], latestLedger: 4 };
    },
    async save() {},
  };
  const source = new ChainEventSource({
    network,
    cache,
    server: {
      async getEvents(request) {
        assert.equal(request.startLedger, 1);
        return { events: [shieldEvent(1)], cursor: "c1", latestLedger: 10 };
      },
    },
  });
  const events = await source.events("C", 1);
  assert.equal(events.length, 1, "cached event rebuilt once, not duplicated");
});

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
