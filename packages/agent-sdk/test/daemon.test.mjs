// Pure daemon decision logic: planReconcile (what to start/stop/skip) and runtimeVersionAction
// (when to re-exec a pinned runtime via npx).

import test from "node:test";
import assert from "node:assert/strict";
import { planReconcile, runtimeVersionAction } from "../dist/index.js";

function stateWith(agents) {
  return { runner: { id: "r", runtime_version: "latest" }, agents };
}

function entry(id, overrides = {}) {
  return {
    agent: { id, desired_state: "running", revoked: false, name: id, ...overrides.agent },
    config: overrides.config === null ? null : { version: 1, provider: "openai", model: "gpt-5", prompt: { preset: "buyer" }, ...overrides.config },
    sealed_root: overrides.sealed_root === null ? null : { v: 1, epk: "00", nonce: "00", ct: "00" },
  };
}

const ENV = { OPENAI_API_KEY: "sk-x" };

test("planReconcile starts runnable agents and stops undesired ones", () => {
  const state = stateWith([
    entry("a"),
    entry("b", { agent: { desired_state: "stopped" } }),
    entry("c", { agent: { revoked: true, desired_state: "running" } }),
  ]);
  const plan = planReconcile(state, ["b", "gone"], ENV, new Map(), Date.now());
  assert.deepEqual(plan.start, ["a"]);
  assert.deepEqual(plan.stop.sort(), ["b", "gone"]);
  assert.deepEqual(plan.skipped, []);
});

test("planReconcile skips agents missing bundle, config, or API key", () => {
  const state = stateWith([
    entry("no-bundle", { sealed_root: null }),
    entry("no-config", { config: null }),
    entry("no-key", { config: { provider: "anthropic" } }), // ANTHROPIC_API_KEY not in ENV
  ]);
  const plan = planReconcile(state, [], ENV, new Map(), Date.now());
  assert.deepEqual(plan.start, []);
  assert.deepEqual(
    plan.skipped.map((s) => s.id),
    ["no-bundle", "no-config", "no-key"],
  );
  assert.match(plan.skipped[0].reason, /sealed key bundle/);
  assert.match(plan.skipped[2].reason, /ANTHROPIC_API_KEY/);
});

test("planReconcile honors crash backoff without stopping the agent", () => {
  const now = Date.now();
  const state = stateWith([entry("a")]);
  const backedOff = planReconcile(state, [], ENV, new Map([["a", now + 60_000]]), now);
  assert.deepEqual(backedOff.start, []);
  assert.match(backedOff.skipped[0].reason, /backoff/);
  const later = planReconcile(state, [], ENV, new Map([["a", now - 1]]), now);
  assert.deepEqual(later.start, ["a"]);
});

test("planReconcile leaves an already-running desired agent alone", () => {
  const plan = planReconcile(stateWith([entry("a")]), ["a"], ENV, new Map(), Date.now());
  assert.deepEqual(plan.start, []);
  assert.deepEqual(plan.stop, []);
});

test("runtimeVersionAction: latest/current/pinned run in place; a semver pin re-execs", () => {
  assert.deepEqual(runtimeVersionAction("0.0.0", "latest", false), { kind: "run" });
  assert.deepEqual(runtimeVersionAction("1.2.3", "1.2.3", false), { kind: "run" });
  assert.deepEqual(runtimeVersionAction("0.0.0", undefined, false), { kind: "run" });
  assert.deepEqual(runtimeVersionAction("0.0.0", "1.2.3", false), { kind: "reexec", version: "1.2.3" });
  // The pinned guard breaks the re-exec loop even on mismatch.
  assert.deepEqual(runtimeVersionAction("0.0.0", "1.2.3", true), { kind: "run" });
  // Garbage pins are ignored rather than exec'd.
  assert.deepEqual(runtimeVersionAction("0.0.0", "not-a-version", false), { kind: "run" });
});
