// handleInboundLog: the pure inbox core, driven with synthetic messages and a stubbed sender
// resolver. Covers valid public/private entries, unknown senders, session/agent mismatch,
// duplicate seq, malformed and oversized content, and session_end side effects.

import test from "node:test";
import assert from "node:assert/strict";
import { deriveAgentRoot } from "@mosaic/agent-sdk";
import { MemoryAgentStore, handleInboundLog, parseLogEnvelope } from "../dist/index.js";

const NETWORK = "Test SDF Network ; September 2015";
const OWN_INBOX = "backend-inbox";

async function setup() {
  const store = new MemoryAgentStore();
  const root = await deriveAgentRoot(new Uint8Array(64).fill(5), {
    chain: "stellar",
    address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    networkPassphrase: NETWORK,
  });
  const identity = await root.deriveIdentity(0);
  const agent = await store.registerAgent("stellar:GM", identity.descriptor("scout"));
  const session = await store.createAgentSession(agent.id);
  const warnings = [];
  const deps = {
    store,
    ownInboxId: OWN_INBOX,
    resolveSenderAddresses: async (inboxId) =>
      inboxId === "agent-inbox" ? [identity.ethAddress.toLowerCase()] : [],
    log: { info: () => {}, warn: (msg) => warnings.push(msg) },
  };
  return { store, identity, agent, session, deps, warnings };
}

function envelope(session, seq, overrides = {}) {
  return JSON.stringify({
    mosaic: "agent-log/v1",
    session_id: session.id,
    seq,
    at: Date.now(),
    visibility: "public",
    kind: "log",
    payload: { seq },
    ...overrides,
  });
}

test("valid public and private entries are stored; duplicates are not", async () => {
  const { store, session, deps } = await setup();
  const msg = (content) => ({ senderInboxId: "agent-inbox", content });

  assert.equal(await handleInboundLog(deps, msg(envelope(session, 1, { kind: "session_start" }))), "stored");
  assert.equal(await handleInboundLog(deps, msg(envelope(session, 2, { visibility: "private" }))), "stored");
  assert.equal(await handleInboundLog(deps, msg(envelope(session, 2, { visibility: "private" }))), "duplicate");

  const entries = await store.logsBySession(session.id);
  assert.deepEqual(entries.map((e) => [e.seq, e.visibility]), [
    [1, "public"],
    [2, "private"],
  ]);
});

test("own messages, non-text content, and non-mosaic JSON are silently ignored", async () => {
  const { deps, session, warnings } = await setup();
  assert.equal(await handleInboundLog(deps, { senderInboxId: OWN_INBOX, content: envelope(session, 1) }), "ignored");
  assert.equal(await handleInboundLog(deps, { senderInboxId: "agent-inbox", content: { group: "update" } }), "ignored");
  assert.equal(await handleInboundLog(deps, { senderInboxId: "agent-inbox", content: "hello there" }), "ignored");
  assert.equal(await handleInboundLog(deps, { senderInboxId: "agent-inbox", content: '{"chat":"hi"}' }), "ignored");
  assert.equal(warnings.length, 0); // silent — the address is public
});

test("malformed envelopes are rejected with a warning", async () => {
  const { deps, session, warnings } = await setup();
  const msg = (content) => ({ senderInboxId: "agent-inbox", content });
  assert.equal(await handleInboundLog(deps, msg(envelope(session, 0))), "ignored"); // seq < 1
  assert.equal(await handleInboundLog(deps, msg(envelope(session, 1, { visibility: "secret" }))), "ignored");
  assert.equal(await handleInboundLog(deps, msg(envelope(session, 1, { kind: "nope" }))), "ignored");
  assert.equal(await handleInboundLog(deps, msg(envelope(session, 1, { session_id: "" }))), "ignored");
  assert.equal(warnings.length, 4);
});

test("oversized content is rejected", async () => {
  const { deps, session, warnings } = await setup();
  const big = envelope(session, 1, { payload: "x".repeat(65 * 1024) });
  assert.equal(await handleInboundLog(deps, { senderInboxId: "agent-inbox", content: big }), "ignored");
  assert.match(warnings[0], /exceeds/);
});

test("unknown senders and revoked agents are rejected", async () => {
  const { store, deps, session, agent, warnings } = await setup();
  assert.equal(await handleInboundLog(deps, { senderInboxId: "stranger", content: envelope(session, 1) }), "ignored");
  assert.match(warnings[0], /0 registered agents/);

  await store.revokeAgent("stellar:GM", agent.id);
  assert.equal(await handleInboundLog(deps, { senderInboxId: "agent-inbox", content: envelope(session, 1) }), "ignored");
});

test("an agent cannot write into another agent's session", async () => {
  const { store, deps, session, warnings } = await setup();
  // A second registered agent with its own inbox.
  const root = await deriveAgentRoot(new Uint8Array(64).fill(6), {
    chain: "stellar",
    address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    networkPassphrase: NETWORK,
  });
  const intruder = await root.deriveIdentity(1);
  await store.registerAgent("stellar:GOTHER", intruder.descriptor());
  const depsWithIntruder = {
    ...deps,
    resolveSenderAddresses: async (inboxId) =>
      inboxId === "intruder-inbox" ? [intruder.ethAddress.toLowerCase()] : deps.resolveSenderAddresses(inboxId),
  };
  assert.equal(
    await handleInboundLog(depsWithIntruder, { senderInboxId: "intruder-inbox", content: envelope(session, 1) }),
    "ignored",
  );
  assert.match(warnings[0], /unknown or not theirs/);
  assert.equal((await store.logsBySession(session.id)).length, 0);
});

test("session_end stores the entry and closes the session", async () => {
  const { store, deps, session } = await setup();
  const content = envelope(session, 1, { kind: "session_end", payload: null });
  assert.equal(await handleInboundLog(deps, { senderInboxId: "agent-inbox", content }), "stored");
  assert.ok((await store.getAgentSession(session.id)).ended_at > 0);
});

test("parseLogEnvelope accepts a valid envelope and passes payload through", () => {
  const parsed = parseLogEnvelope(
    JSON.stringify({
      mosaic: "agent-log/v1",
      session_id: "s",
      seq: 3,
      at: 123,
      visibility: "private",
      kind: "log",
      payload: { nested: [1, 2] },
    }),
  );
  assert.ok("envelope" in parsed);
  assert.deepEqual(parsed.envelope.payload, { nested: [1, 2] });
});
