// Wallet authentication for the MCP: a client proves control of a Stellar address by signing a
// server-issued challenge with its ed25519 key (verified via stellar-sdk). Tools that need
// authorization take the returned session token. In-memory, single-process state — fine for the
// minimal server; swap for a shared store when scaling.

import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { sep53Digest } from "@mosaic/sdk";
import type { MosaicStore } from "./store.js";

export interface Session {
  address: string;
  network: string;
  token: string;
  expiresAt: number;
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 60 * 60_000;

export class AuthService {
  private readonly store?: MosaicStore;
  private readonly challenges = new Map<
    string,
    { address: string; message: string; expiresAt: number }
  >();
  private readonly sessions = new Map<string, Session>();

  constructor(store?: MosaicStore) {
    this.store = store;
  }

  /** Issue a challenge for `address` to sign. */
  async challenge(address: string): Promise<{ challengeId: string; message: string; expires_at: number }> {
    Keypair.fromPublicKey(address); // validates the strkey (throws on a bad address)
    const challengeId = randomBytes(16).toString("hex");
    const nonce = randomBytes(24).toString("hex");
    const message = `Stellar Mosaic MCP authentication\nAddress: ${address}\nNonce: ${nonce}`;
    if (this.store) {
      const stored = await this.store.createChallenge(address, message);
      return { challengeId: stored.id, message: stored.message, expires_at: stored.expires_at };
    }
    this.challenges.set(challengeId, { address, message, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    return { challengeId, message, expires_at: Date.now() + CHALLENGE_TTL_MS };
  }

  /** Verify the ed25519 signature over a prior challenge; on success, issue a session token. */
  async verify(address: string, challengeId: string, signatureB64: string): Promise<{ token: string }> {
    const c = this.store
      ? await this.store.consumeChallenge(challengeId, address).then((stored) => ({
          address: stored.address,
          message: stored.message,
          expiresAt: stored.expires_at,
        }))
      : this.challenges.get(challengeId);
    if (!c || c.address !== address) throw new Error("unknown or mismatched challenge");
    if (Date.now() > c.expiresAt) {
      this.challenges.delete(challengeId);
      throw new Error("challenge expired");
    }
    // SEP-0053: wallets sign SHA256("Stellar Signed Message:\n" || message), not the raw bytes.
    const ok = Keypair.fromPublicKey(address).verify(
      Buffer.from(sep53Digest(Buffer.from(c.message, "utf8"))),
      Buffer.from(signatureB64, "base64"),
    );
    if (!ok) throw new Error("signature verification failed");
    if (!this.store) this.challenges.delete(challengeId);
    if (this.store) return this.store.createSession(address, "testnet").then(({ token }) => ({ token }));
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, { address, network: "testnet", token, expiresAt: Date.now() + SESSION_TTL_MS });
    return { token };
  }

  /** Return the session for a token, or throw if missing/expired. */
  async requireSession(token: string): Promise<Session> {
    if (this.store) {
      const session = await this.store.getSession(token);
      if (!session) throw new Error("invalid or expired session");
      return { address: session.address, network: session.network, token, expiresAt: session.expires_at ?? Date.now() + SESSION_TTL_MS };
    }
    const s = this.sessions.get(token);
    if (!s || Date.now() > s.expiresAt) throw new Error("invalid or expired session");
    return s;
  }

  async getSession(token: string): Promise<Session | null> {
    try {
      return await this.requireSession(token);
    } catch {
      return null;
    }
  }

  async logout(token: string): Promise<void> {
    if (this.store) await this.store.deleteSession(token);
    else this.sessions.delete(token);
  }
}
