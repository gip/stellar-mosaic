// Unit tests for the MCP auth service: ed25519 challenge/verify roundtrip + session handling.
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { AuthService } from "../dist/auth.js";

test("challenge/verify roundtrip issues a usable session", async () => {
  const kp = Keypair.random();
  const svc = new AuthService();
  const { challengeId, message } = await svc.challenge(kp.publicKey());
  const sig = kp.sign(Buffer.from(message, "utf8")).toString("base64");
  const { token } = await svc.verify(kp.publicKey(), challengeId, sig);
  assert.equal((await svc.requireSession(token)).address, kp.publicKey());
});

test("a signature from a different key is rejected", async () => {
  const kp = Keypair.random();
  const other = Keypair.random();
  const svc = new AuthService();
  const { challengeId, message } = await svc.challenge(kp.publicKey());
  const badSig = other.sign(Buffer.from(message, "utf8")).toString("base64");
  await assert.rejects(() => svc.verify(kp.publicKey(), challengeId, badSig), /verification failed/);
});

test("an unknown session token throws", async () => {
  await assert.rejects(() => new AuthService().requireSession("nope"), /invalid or expired/);
});
