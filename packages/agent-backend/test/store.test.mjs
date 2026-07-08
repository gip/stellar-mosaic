// Store twins: every assertion runs against both MemoryAgentStore and SqliteAgentStore, plus a
// sqlite-only reopen test proving persistence survives a process restart.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryAgentStore, SqliteAgentStore } from "../dist/index.js";

function descriptor(index, overrides = {}) {
  const pad = String(index).padStart(2, "0");
  return {
    derivation_version: 1,
    master_chain: "stellar",
    master_address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    network_passphrase: "Test SDF Network ; September 2015",
    index,
    // Syntactically plausible unique keys; the store validates shape, not curve membership.
    stellar_public_key: `GTESTKEY${pad}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    eth_address: `0x${pad.repeat(20)}`,
    ...overrides,
  };
}

const stores = [
  ["memory", () => new MemoryAgentStore()],
  ["sqlite", () => new SqliteAgentStore("sqlite://:memory:")],
];

for (const [name, make] of stores) {
  test(`${name}: challenges are single-use, subject-bound, and expire`, async () => {
    const store = make();
    const c = await store.createChallenge("master:stellar:GABC", "msg");
    assert.ok(c.expires_at > Date.now());
    await assert.rejects(store.consumeChallenge(c.id, "master:stellar:GXYZ"), /unknown or expired/);
    const consumed = await store.consumeChallenge(c.id, "master:stellar:GABC");
    assert.equal(consumed.message, "msg");
    await assert.rejects(store.consumeChallenge(c.id, "master:stellar:GABC"), /unknown or expired/);
  });

  test(`${name}: sessions roundtrip and delete`, async () => {
    const store = make();
    const { token, session } = await store.createSession({ kind: "master", master_id: "stellar:GABC" });
    assert.equal(session.kind, "master");
    const got = await store.getSession(token);
    assert.equal(got.master_id, "stellar:GABC");
    assert.equal(await store.getSession("deadbeef"), null);
    await store.deleteSession(token);
    assert.equal(await store.getSession(token), null);
  });

  test(`${name}: master upsert is idempotent and lowercases eth`, async () => {
    const store = make();
    const a = await store.upsertMaster("ethereum", "0xAbCd000000000000000000000000000000000001");
    const b = await store.upsertMaster("ethereum", "0xabcd000000000000000000000000000000000001");
    assert.equal(a.id, b.id);
    assert.equal(a.address, "0xabcd000000000000000000000000000000000001");
  });

  test(`${name}: agent registration is idempotent on identical descriptor, 409 on mismatch`, async () => {
    const store = make();
    const master = "stellar:GMASTER";
    const first = await store.registerAgent(master, descriptor(0));
    const again = await store.registerAgent(master, descriptor(0));
    assert.equal(again.id, first.id);
    // Same index, different keys → conflict.
    await assert.rejects(
      store.registerAgent(master, descriptor(0, { stellar_public_key: "GOTHERKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })),
      (e) => e.status === 409,
    );
    // Same keys under another master → conflict.
    await assert.rejects(store.registerAgent("stellar:GOTHER", descriptor(0)), (e) => e.status === 409);
    // Lookups.
    assert.equal((await store.agentByStellarKey(first.stellar_public_key)).id, first.id);
    assert.equal((await store.agentByEthAddress(first.eth_address.toUpperCase())).id, first.id);
    assert.equal(await store.agentByStellarKey("GNOPE"), null);
    const listed = await store.listAgents(master);
    assert.equal(listed.length, 1);
  });

  test(`${name}: desired state, revocation, ownership`, async () => {
    const store = make();
    const agent = await store.registerAgent("stellar:GM", descriptor(1));
    assert.equal(agent.desired_state, "stopped");
    const running = await store.setDesiredState("stellar:GM", agent.id, "running");
    assert.equal(running.desired_state, "running");
    await assert.rejects(store.setDesiredState("stellar:GOTHER", agent.id, "stopped"), (e) => e.status === 404);
    const revoked = await store.revokeAgent("stellar:GM", agent.id);
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.desired_state, "stopped");
    await assert.rejects(store.setDesiredState("stellar:GM", agent.id, "running"), (e) => e.status === 409);
  });

  test(`${name}: runners register/update/revoke/heartbeat`, async () => {
    const store = make();
    const runner = await store.registerRunner("stellar:GM", {
      auth_public_key: "GAUTHKEY",
      seal_public_key: "aa".repeat(32),
      name: "laptop",
    });
    assert.equal(runner.runtime_version, "latest");
    const updated = await store.updateRunner("stellar:GM", runner.id, { runtime_version: "1.2.3" });
    assert.equal(updated.runtime_version, "1.2.3");
    await assert.rejects(store.updateRunner("stellar:GX", runner.id, {}), (e) => e.status === 404);

    // Heartbeats: first instance holds it; a second live instance conflicts; same instance is fine.
    assert.deepEqual(await store.heartbeatRunner(runner.id, "inst-a"), { conflict: false });
    assert.deepEqual(await store.heartbeatRunner(runner.id, "inst-b"), { conflict: true });
    assert.deepEqual(await store.heartbeatRunner(runner.id, "inst-a"), { conflict: false });

    const revoked = await store.revokeRunner("stellar:GM", runner.id);
    assert.equal(revoked.revoked, true);
    await assert.rejects(store.heartbeatRunner(runner.id, "inst-a"), (e) => e.status === 404);
  });

  test(`${name}: sealed roots are upserted and scoped to (agent, runner)`, async () => {
    const store = make();
    const agent = await store.registerAgent("stellar:GM", descriptor(2));
    const runner = await store.registerRunner("stellar:GM", { auth_public_key: "GA", seal_public_key: "bb".repeat(32) });
    assert.equal(await store.sealedRoot(agent.id, runner.id), null);
    await store.putSealedRoot("stellar:GM", agent.id, runner.id, { v: 1, epk: "01", nonce: "02", ct: "03" });
    await store.putSealedRoot("stellar:GM", agent.id, runner.id, { v: 1, epk: "0a", nonce: "0b", ct: "0c" });
    assert.equal((await store.sealedRoot(agent.id, runner.id)).epk, "0a");
    await assert.rejects(
      store.putSealedRoot("stellar:GOTHER", agent.id, runner.id, { v: 1, epk: "01", nonce: "02", ct: "03" }),
      (e) => e.status === 404,
    );
  });

  test(`${name}: agent data upsert/read/delete by kind`, async () => {
    const store = make();
    await store.putAgentData("agent-1", "attached", "agent-config", { version: 1 }, "master");
    await store.putAgentData("agent-1", "attached", "agent-config", { version: 1, model: "x" }, "master");
    await store.putAgentData("agent-1", "scratch", "state", { step: 3 }, "agent");
    const attached = await store.agentData("agent-1", "attached");
    assert.deepEqual(attached["agent-config"].value, { version: 1, model: "x" });
    assert.equal(attached["agent-config"].updated_by, "master");
    const scratch = await store.agentData("agent-1", "scratch");
    assert.deepEqual(Object.keys(scratch), ["state"]);
    await store.deleteAgentData("agent-1", "scratch", "state");
    assert.deepEqual(await store.agentData("agent-1", "scratch"), {});
  });

  test(`${name}: log entries dedupe on (session, seq) and filter correctly`, async () => {
    const store = make();
    const agent = await store.registerAgent("stellar:GM", descriptor(3));
    const other = await store.registerAgent("stellar:GOTHER", descriptor(4));
    const session = await store.createAgentSession(agent.id);
    const otherSession = await store.createAgentSession(other.id);

    const entry = (seq, visibility, sid = session.id, aid = agent.id) => ({
      session_id: sid,
      agent_id: aid,
      seq,
      at: 1000 + seq,
      visibility,
      kind: "log",
      payload: { seq },
    });

    // Out-of-order arrival is fine; duplicates are ignored.
    assert.ok(await store.insertLogEntry(entry(2, "public")));
    assert.ok(await store.insertLogEntry(entry(1, "private")));
    assert.equal(await store.insertLogEntry(entry(2, "public")), null);
    assert.ok(await store.insertLogEntry(entry(1, "public", otherSession.id, other.id)));

    const bySession = await store.logsBySession(session.id);
    assert.deepEqual(bySession.map((l) => l.seq), [1, 2]);
    const publicOnly = await store.logsBySession(session.id, { publicOnly: true });
    assert.deepEqual(publicOnly.map((l) => l.seq), [2]);

    const pub = await store.publicLogs({});
    assert.equal(pub.every((l) => l.visibility === "public"), true);
    assert.equal(pub.length, 2);
    const pubForAgent = await store.publicLogs({ agentId: agent.id });
    assert.equal(pubForAgent.length, 1);

    const mine = await store.masterLogs("stellar:GM", {});
    assert.equal(mine.length, 2); // private included, other master's excluded
    assert.ok(mine.every((l) => l.agent_id === agent.id));

    // Cursor pagination.
    const all = await store.publicLogs({});
    const after = await store.publicLogs({ afterCursor: all[0].cursor });
    assert.equal(after.length, 1);

    // Session counters.
    const updated = await store.getAgentSession(session.id);
    assert.equal(updated.log_count, 2);
    assert.ok(updated.last_log_at > 0);
    await store.endAgentSession(session.id);
    assert.ok((await store.getAgentSession(session.id)).ended_at > 0);
    const sessions = await store.listAgentSessions(agent.id);
    assert.equal(sessions.length, 1);
  });
}

test("sqlite: state survives reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mosaic-agent-store-"));
  const url = `sqlite://${join(dir, "test.db")}`;
  const first = new SqliteAgentStore(url);
  const agent = await first.registerAgent("stellar:GM", descriptor(0));
  const runner = await first.registerRunner("stellar:GM", { auth_public_key: "GA", seal_public_key: "cc".repeat(32) });
  await first.putSealedRoot("stellar:GM", agent.id, runner.id, { v: 1, epk: "01", nonce: "02", ct: "03" });
  const session = await first.createAgentSession(agent.id);
  await first.insertLogEntry({
    session_id: session.id,
    agent_id: agent.id,
    seq: 1,
    at: 1,
    visibility: "public",
    kind: "session_start",
    payload: null,
  });

  const reopened = new SqliteAgentStore(url);
  assert.equal((await reopened.getAgent(agent.id)).stellar_public_key, agent.stellar_public_key);
  assert.equal((await reopened.sealedRoot(agent.id, runner.id)).ct, "03");
  assert.equal((await reopened.logsBySession(session.id)).length, 1);
  // The dedupe constraint also survives.
  assert.equal(
    await reopened.insertLogEntry({
      session_id: session.id,
      agent_id: agent.id,
      seq: 1,
      at: 2,
      visibility: "public",
      kind: "session_start",
      payload: null,
    }),
    null,
  );
});
