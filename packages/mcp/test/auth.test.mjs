// Unit tests for the MCP auth service: ed25519 challenge/verify roundtrip + session handling.
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { AuthService } from "../dist/auth.js";

test("challenge/verify roundtrip issues a usable session", () => {
  const kp = Keypair.random();
  const svc = new AuthService();
  const { challengeId, message } = svc.challenge(kp.publicKey());
  const sig = kp.sign(Buffer.from(message, "utf8")).toString("base64");
  const { token } = svc.verify(kp.publicKey(), challengeId, sig);
  assert.equal(svc.requireSession(token).address, kp.publicKey());
});

test("a signature from a different key is rejected", () => {
  const kp = Keypair.random();
  const other = Keypair.random();
  const svc = new AuthService();
  const { challengeId, message } = svc.challenge(kp.publicKey());
  const badSig = other.sign(Buffer.from(message, "utf8")).toString("base64");
  assert.throws(() => svc.verify(kp.publicKey(), challengeId, badSig), /verification failed/);
});

test("an unknown session token throws", () => {
  assert.throws(() => new AuthService().requireSession("nope"), /invalid or expired/);
});
