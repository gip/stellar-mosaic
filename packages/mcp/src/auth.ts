// Wallet authentication for the MCP: a client proves control of a Stellar address by signing a
// server-issued challenge with its ed25519 key (verified via stellar-sdk). Tools that need
// authorization take the returned session token. In-memory, single-process state — fine for the
// minimal server; swap for a shared store when scaling.

import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { sep53Digest } from "@mosaic/sdk";
import type { MosaicStore } from "./store.js";
import { MosaicMcpError } from "./errors.js";

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
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(store?: MosaicStore) {
    this.store = store;
  }

  private rateLimit(key: string, limit = 20, windowMs = 60_000): void {
    const current = this.attempts.get(key);
    const at = Date.now();
    if (!current || current.resetAt < at) {
      // Opportunistically evict expired windows so the map can't grow without bound as distinct
      // addresses churn through (each key would otherwise leave a permanent entry).
      if (this.attempts.size > 1_000) {
        for (const [k, v] of this.attempts) if (v.resetAt < at) this.attempts.delete(k);
      }
      this.attempts.set(key, { count: 1, resetAt: at + windowMs });
      return;
    }
    current.count += 1;
    if (current.count > limit) throw new MosaicMcpError("AUTH_INVALID", "authentication rate limit exceeded", { retryable: true, status: 429 });
  }

  /** Issue a challenge for `address` to sign. */
  async challenge(
    address: string,
    opts: { network?: string; audience?: string } = {},
  ): Promise<{ challengeId: string; message: string; expires_at: number; network: string; audience: string }> {
    Keypair.fromPublicKey(address); // validates the strkey (throws on a bad address)
    this.rateLimit(`challenge:${address}`);
    const network = validateNetwork(opts.network ?? "testnet");
    const audience = String(opts.audience ?? "mosaic-mcp").slice(0, 200);
    const challengeId = randomBytes(16).toString("hex");
    const nonce = randomBytes(24).toString("hex");
    const issuedAt = Date.now();
    const expiresAt = issuedAt + CHALLENGE_TTL_MS;
    const message =
      `Stellar Mosaic MCP authentication\n` +
      `Address: ${address}\n` +
      `Network: ${network}\n` +
      `Audience: ${audience}\n` +
      `Issued At: ${issuedAt}\n` +
      `Expires At: ${expiresAt}\n` +
      `Nonce: ${nonce}`;
    if (this.store) {
      const stored = await this.store.createChallenge(address, message, network, audience);
      return { challengeId: stored.id, message: stored.message, expires_at: stored.expires_at, network: stored.network, audience: stored.audience };
    }
    this.challenges.set(challengeId, { address, message, expiresAt });
    return { challengeId, message, expires_at: expiresAt, network, audience };
  }

  /** Verify the ed25519 signature over a prior challenge; on success, issue a session token. */
  async verify(address: string, challengeId: string, signatureB64: string): Promise<{ token: string }> {
    this.rateLimit(`verify:${address}`);
    const c = this.store
      ? await this.store.consumeChallenge(challengeId, address).then((stored) => ({
          address: stored.address,
          message: stored.message,
          expiresAt: stored.expires_at,
          network: stored.network,
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
    const storedNetwork = (c as unknown as { network?: unknown }).network;
    const network = validateNetwork(typeof storedNetwork === "string" ? storedNetwork : parseNetworkFromMessage(c.message) ?? "testnet");
    if (this.store) return this.store.createSession(address, network).then(({ token }) => ({ token }));
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, { address, network, token, expiresAt: Date.now() + SESSION_TTL_MS });
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

export function validateNetwork(network: string): string {
  if (network === "testnet" || network === "public") return network;
  throw new MosaicMcpError("VALIDATION_FAILED", `unsupported network: ${network}`);
}

function parseNetworkFromMessage(message: string): string | undefined {
  const match = message.match(/^Network: (.+)$/m);
  return match ? validateNetwork(match[1]) : undefined;
}
