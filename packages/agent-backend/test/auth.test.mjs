// AgentAuthService: challenge/verify for masters (stellar + ethereum), runners, and agents, with
// real signatures (stellar-sdk SEP-0053 and viem EIP-191).

import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Keypair } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sep53Digest } from "@mosaic/sdk";
import { deriveAgentRoot, deriveRunnerKeys, generateRunnerSecret, toHex } from "@mosaic/agent-sdk";
import { AgentAuthService, MemoryAgentStore } from "../dist/index.js";

const NETWORK = "Test SDF Network ; September 2015";

function sep53Sign(keypair, message) {
  return keypair.sign(Buffer.from(sep53Digest(Buffer.from(message, "utf8")))).toString("base64");
}

async function registeredAgent(store) {
  const master = Keypair.random();
  const root = await deriveAgentRoot(new Uint8Array(64).fill(1), {
    chain: "stellar",
    address: master.publicKey(),
    networkPassphrase: NETWORK,
  });
  const identity = await root.deriveIdentity(0);
  const masterId = `stellar:${master.publicKey()}`;
  const record = await store.registerAgent(masterId, identity.descriptor("scout"));
  return { identity, record, masterId };
}

test("stellar master: challenge → verify → session; wrong key rejected", async () => {
  const store = new MemoryAgentStore();
  const auth = new AgentAuthService(store);
  const kp = Keypair.random();

  const challenge = await auth.masterChallenge("stellar", kp.publicKey());
  assert.match(challenge.message, /Chain: stellar/);
  const { token, master_id } = await auth.masterVerify("stellar", kp.publicKey(), challenge.challenge_id, sep53Sign(kp, challenge.message));
  assert.equal(master_id, `stellar:${kp.publicKey()}`);
  const session = await auth.requireSession(token, "master");
  assert.equal(session.master_id, master_id);

  // Wrong key on a fresh challenge.
  const c2 = await auth.masterChallenge("stellar", kp.publicKey());
  await assert.rejects(
    auth.masterVerify("stellar", kp.publicKey(), c2.challenge_id, sep53Sign(Keypair.random(), c2.message)),
    /verification failed/,
  );
  // Challenges are single-use.
  await assert.rejects(
    auth.masterVerify("stellar", kp.publicKey(), challenge.challenge_id, sep53Sign(kp, challenge.message)),
    /unknown or expired/,
  );
  await assert.rejects(auth.masterChallenge("stellar", "not-an-address"), /invalid stellar/);
});

test("ethereum master: EIP-191 recovery, case-insensitive, upserts lowercase id", async () => {
  const store = new MemoryAgentStore();
  const auth = new AgentAuthService(store);
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);

  const challenge = await auth.masterChallenge("ethereum", account.address);
  const signature = await account.signMessage({ message: challenge.message });
  const { token, master_id } = await auth.masterVerify("ethereum", account.address, challenge.challenge_id, signature);
  assert.equal(master_id, `ethereum:${account.address.toLowerCase()}`);
  assert.ok(await auth.requireSession(token, "master"));

  // A signature from a different key fails.
  const other = privateKeyToAccount(generatePrivateKey());
  const c2 = await auth.masterChallenge("ethereum", account.address);
  const bad = await other.signMessage({ message: c2.message });
  await assert.rejects(auth.masterVerify("ethereum", account.address, c2.challenge_id, bad), /verification failed/);
  await assert.rejects(auth.masterChallenge("ethereum", "0xnope"), /invalid ethereum/);
});

test("runner: register → challenge → verify with the derived auth key; revoked refused", async () => {
  const store = new MemoryAgentStore();
  const auth = new AgentAuthService(store);
  const keys = await deriveRunnerKeys(generateRunnerSecret());
  const runner = await store.registerRunner("stellar:GM", {
    auth_public_key: keys.authPublicKey,
    seal_public_key: toHex(keys.sealPublicKey),
  });

  const challenge = await auth.runnerChallenge(runner.id);
  const { token, runner_id } = await auth.runnerVerify(runner.id, challenge.challenge_id, sep53Sign(keys.authKeypair, challenge.message));
  assert.equal(runner_id, runner.id);
  const session = await auth.requireSession(token, "runner");
  assert.equal(session.master_id, "stellar:GM");

  // Wrong runner keypair fails.
  const c2 = await auth.runnerChallenge(runner.id);
  const otherKeys = await deriveRunnerKeys(generateRunnerSecret());
  await assert.rejects(auth.runnerVerify(runner.id, c2.challenge_id, sep53Sign(otherKeys.authKeypair, c2.message)), /verification failed/);

  await store.revokeRunner("stellar:GM", runner.id);
  await assert.rejects(auth.runnerChallenge(runner.id), /not found/);
});

test("agent: challenge/verify with the derived stellar key creates an agent session", async () => {
  const store = new MemoryAgentStore();
  const auth = new AgentAuthService(store);
  const { identity, record } = await registeredAgent(store);

  const challenge = await auth.agentChallenge(identity.stellarPublicKey);
  const result = await auth.agentVerify(
    identity.stellarPublicKey,
    challenge.challenge_id,
    sep53Sign(identity.stellarKeypair, challenge.message),
  );
  assert.equal(result.agent.id, record.id);
  assert.equal(result.session.agent_id, record.id);
  const session = await auth.requireSession(result.token, "agent");
  assert.equal(session.session_id, result.session.id);
  assert.ok(await store.getAgentSession(result.session.id));

  // Unregistered and revoked identities are refused at challenge time.
  await assert.rejects(auth.agentChallenge(Keypair.random().publicKey()), /not registered/);
  await store.revokeAgent(record.master_id, record.id);
  await assert.rejects(auth.agentChallenge(identity.stellarPublicKey), /not registered/);
});

test("requireSession enforces kind and expiry semantics", async () => {
  const store = new MemoryAgentStore();
  const auth = new AgentAuthService(store);
  const { token } = await store.createSession({ kind: "master", master_id: "stellar:GM" });
  await assert.rejects(auth.requireSession(token, "agent"), /needs a agent session/);
  await assert.rejects(auth.requireSession(undefined), /missing bearer/);
  await assert.rejects(auth.requireSession("bogus"), /invalid or expired/);
  await auth.logout(token);
  await assert.rejects(auth.requireSession(token), /invalid or expired/);
});
