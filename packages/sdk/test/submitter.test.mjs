import test from "node:test";
import assert from "node:assert/strict";
import { xdr } from "@stellar/stellar-sdk";
import { MemoryStore, SponsoredSubmitter } from "../dist/index.js";

const bytes = (value) => xdr.ScVal.scvBytes(Buffer.from(value));
const network = { rpcUrl: "https://example.invalid", networkPassphrase: "Test SDF Network ; September 2015" };

test("SponsoredSubmitter records submitted and succeeded transaction activity with returned hash", async () => {
  const activity = new MemoryStore();
  const submitter = new SponsoredSubmitter({
    network,
    signer: {},
    desks: {},
    activity,
    mcp: {
      async relayOrder() {
        return { txHash: "tx-sponsored", status: "SUCCESS" };
      },
    },
  });

  const result = await submitter.submit({
    deskId: "d",
    contractId: "C",
    method: "submit_order",
    args: [bytes("proof"), bytes("inputs")],
  });

  assert.equal(result.txHash, "tx-sponsored");
  const events = await activity.list({ kind: "transaction" });
  assert.deepEqual(events.map((event) => event.status), ["submitted", "succeeded"]);
  assert.equal(events[1].tx_hash, "tx-sponsored");
  assert.equal(events[1].method, "submit_order");
});

test("SponsoredSubmitter records failed transaction activity", async () => {
  const activity = new MemoryStore();
  const submitter = new SponsoredSubmitter({
    network,
    signer: {},
    desks: {},
    activity,
    mcp: {
      async relayJoin() {
        throw new Error("relay down");
      },
    },
  });

  await assert.rejects(
    () => submitter.submit({ deskId: "d", contractId: "C", method: "join", args: [bytes("p"), bytes("i")] }),
    /relay down/,
  );
  const events = await activity.list({ kind: "transaction" });
  assert.deepEqual(events.map((event) => event.status), ["submitted", "failed"]);
  assert.match(events[1].message, /relay down/);
});
