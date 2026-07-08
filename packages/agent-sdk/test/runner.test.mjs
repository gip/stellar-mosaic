// Runner credential tests: MOSAIC_IDENTITY codec, deterministic runner-key derivation (frozen
// vectors), and the X25519+AES-GCM sealing of agent roots.

import test from "node:test";
import assert from "node:assert/strict";
import {
  generateRunnerSecret,
  deriveRunnerKeys,
  encodeRunnerIdentity,
  decodeRunnerIdentity,
  sealAgentRoot,
  openAgentRoot,
  toHex,
} from "../dist/portable.js";

const FIXED_SECRET = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);

test("runner keys are frozen golden vectors", async () => {
  const keys = await deriveRunnerKeys(FIXED_SECRET);
  assert.equal(keys.authPublicKey, "GC7GX3U2T3BTQDMOGB2VOU6GH32U7IIFDVKDE7PNVFW56ZDDR3MJ4TL7");
  assert.equal(toHex(keys.sealPublicKey), "78d94e576a9f753852117a441b1cc918df1dad9541f623c4040d837fac792957");
});

test("MOSAIC_IDENTITY codec roundtrips", () => {
  const secret = generateRunnerSecret();
  const encoded = encodeRunnerIdentity({ backend: "http://127.0.0.1:8791", id: "runner-123", secret });
  assert.ok(encoded.startsWith("mosaic-runner-"));
  const decoded = decodeRunnerIdentity(encoded);
  assert.equal(decoded.backend, "http://127.0.0.1:8791");
  assert.equal(decoded.id, "runner-123");
  assert.equal(toHex(decoded.secret), toHex(secret));
  assert.throws(() => decodeRunnerIdentity("nope"), /must start with/);
  assert.throws(() => decodeRunnerIdentity("mosaic-runner-!!!!"), /base64url|format/);
});

test("seal/open agent root roundtrips and binds (agent, runner)", async () => {
  const keys = await deriveRunnerKeys(FIXED_SECRET);
  const agentRoot = crypto.getRandomValues(new Uint8Array(32));
  const binding = { agentId: "agent-a", runnerId: "runner-r" };
  const envelope = await sealAgentRoot(agentRoot, keys.sealPublicKey, binding);
  assert.equal(envelope.v, 1);

  const opened = await openAgentRoot(envelope, keys.sealSecretKey, binding);
  assert.equal(toHex(opened), toHex(agentRoot));

  // Wrong binding (AAD) fails.
  await assert.rejects(
    openAgentRoot(envelope, keys.sealSecretKey, { agentId: "agent-b", runnerId: "runner-r" }),
    /failed to open/,
  );
  // Wrong runner key fails.
  const other = await deriveRunnerKeys(generateRunnerSecret());
  await assert.rejects(openAgentRoot(envelope, other.sealSecretKey, binding), /failed to open/);
  // Tampered ciphertext fails.
  const tampered = { ...envelope, ct: envelope.ct.slice(0, -2) + (envelope.ct.endsWith("00") ? "01" : "00") };
  await assert.rejects(openAgentRoot(tampered, keys.sealSecretKey, binding), /failed to open/);
});

test("each seal uses a fresh ephemeral key", async () => {
  const keys = await deriveRunnerKeys(FIXED_SECRET);
  const agentRoot = new Uint8Array(32).fill(7);
  const binding = { agentId: "a", runnerId: "r" };
  const one = await sealAgentRoot(agentRoot, keys.sealPublicKey, binding);
  const two = await sealAgentRoot(agentRoot, keys.sealPublicKey, binding);
  assert.notEqual(one.epk, two.epk);
  assert.notEqual(one.ct, two.ct);
});
