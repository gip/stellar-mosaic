// Unit tests for the MCP auth service: ed25519 challenge/verify roundtrip + session handling.
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { sep53Digest } from "@mosaic/sdk";
import { AuthService } from "../dist/auth.js";

const signChallenge = (kp, message) =>
  kp.sign(Buffer.from(sep53Digest(new TextEncoder().encode(message)))).toString("base64");

test("challenge/verify roundtrip issues a usable session", async () => {
  const kp = Keypair.random();
  const svc = new AuthService();
  const { challengeId, message } = await svc.challenge(kp.publicKey());
  const sig = signChallenge(kp, message);
  const { token } = await svc.verify(kp.publicKey(), challengeId, sig);
  assert.equal((await svc.requireSession(token)).address, kp.publicKey());
});

test("a signature from a different key is rejected", async () => {
  const kp = Keypair.random();
  const other = Keypair.random();
  const svc = new AuthService();
  const { challengeId, message } = await svc.challenge(kp.publicKey());
  const badSig = signChallenge(other, message);
  await assert.rejects(() => svc.verify(kp.publicKey(), challengeId, badSig), /verification failed/);
});

test("an unknown session token throws", async () => {
  await assert.rejects(() => new AuthService().requireSession("nope"), /invalid or expired/);
});

test("repeated challenges from one address are rate limited on a shared service", async () => {
  // The HTTP server shares one AuthService across sessions precisely so this limiter is not reset by
  // opening a fresh MCP session per attempt. Drive the shared instance directly.
  const kp = Keypair.random();
  const svc = new AuthService();
  for (let i = 0; i < 20; i++) await svc.challenge(kp.publicKey());
  await assert.rejects(() => svc.challenge(kp.publicKey()), /rate limit exceeded/);
});
