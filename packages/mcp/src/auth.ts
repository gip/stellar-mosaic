// Wallet authentication for the MCP: a client proves control of a Stellar address by signing a
// server-issued challenge with its ed25519 key (verified via stellar-sdk). Tools that need
// authorization take the returned session token. In-memory, single-process state — fine for the
// minimal server; swap for a shared store when scaling.

import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

export interface Session {
  address: string;
  token: string;
  expiresAt: number;
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 60 * 60_000;

export class AuthService {
  private readonly challenges = new Map<
    string,
    { address: string; message: string; expiresAt: number }
  >();
  private readonly sessions = new Map<string, Session>();

  /** Issue a challenge for `address` to sign. */
  challenge(address: string): { challengeId: string; message: string } {
    Keypair.fromPublicKey(address); // validates the strkey (throws on a bad address)
    const challengeId = randomBytes(16).toString("hex");
    const nonce = randomBytes(24).toString("hex");
    const message = `Stellar Mosaic MCP authentication\nAddress: ${address}\nNonce: ${nonce}`;
    this.challenges.set(challengeId, { address, message, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    return { challengeId, message };
  }

  /** Verify the ed25519 signature over a prior challenge; on success, issue a session token. */
  verify(address: string, challengeId: string, signatureB64: string): { token: string } {
    const c = this.challenges.get(challengeId);
    if (!c || c.address !== address) throw new Error("unknown or mismatched challenge");
    if (Date.now() > c.expiresAt) {
      this.challenges.delete(challengeId);
      throw new Error("challenge expired");
    }
    const ok = Keypair.fromPublicKey(address).verify(
      Buffer.from(c.message, "utf8"),
      Buffer.from(signatureB64, "base64"),
    );
    if (!ok) throw new Error("signature verification failed");
    this.challenges.delete(challengeId);
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, { address, token, expiresAt: Date.now() + SESSION_TTL_MS });
    return { token };
  }

  /** Return the session for a token, or throw if missing/expired. */
  requireSession(token: string): Session {
    const s = this.sessions.get(token);
    if (!s || Date.now() > s.expiresAt) throw new Error("invalid or expired session");
    return s;
  }
}
