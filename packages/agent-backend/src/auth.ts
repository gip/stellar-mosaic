// Challenge/verify auth for the three principals, copying the MCP AuthService shape
// (packages/mcp/src/auth.ts): server-issued single-use challenge (5 min TTL) → signature verify →
// bearer session (1 h, sha256-hashed at rest). Stellar-side verification is SEP-0053 everywhere —
// masters, runners (their auth key is an ed25519 keypair in Stellar form), and agents all sign
// `sep53Digest(message)`. Ethereum masters use EIP-191 recovery (pure secp256k1, no RPC).

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { Keypair } from "@stellar/stellar-sdk";
import { sep53Digest } from "@mosaic/sdk";
import { isAddress, recoverMessageAddress } from "viem";
import { AgentBackendError, masterId, type AgentStore, type SessionPayload, type StoredSession } from "./store.js";
import type { AgentRecord, AgentSessionRecord } from "@mosaic/agent-sdk";

const err = (status: number, message: string) => new AgentBackendError(status, message);

export interface Challenge {
  challenge_id: string;
  message: string;
  expires_at: number;
}

function nonce(): string {
  return randomBytes(24).toString("hex");
}

function verifySep53(publicKey: string, message: string, signatureB64: string): void {
  let ok = false;
  try {
    ok = Keypair.fromPublicKey(publicKey).verify(
      Buffer.from(sep53Digest(Buffer.from(message, "utf8"))),
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw err(401, "signature verification failed");
}

export class AgentAuthService {
  constructor(private readonly store: AgentStore) {}

  // -- master ---------------------------------------------------------------

  async masterChallenge(chain: "stellar" | "ethereum", address: string): Promise<Challenge> {
    if (chain === "stellar") {
      try {
        Keypair.fromPublicKey(address);
      } catch {
        throw err(400, "invalid stellar address");
      }
    } else if (!isAddress(address)) {
      throw err(400, "invalid ethereum address");
    }
    const message = `Stellar Mosaic Agent Backend authentication\nChain: ${chain}\nAddress: ${address}\nNonce: ${nonce()}`;
    const stored = await this.store.createChallenge(`master:${masterId(chain, address)}`, message);
    return { challenge_id: stored.id, message: stored.message, expires_at: stored.expires_at };
  }

  async masterVerify(
    chain: "stellar" | "ethereum",
    address: string,
    challengeId: string,
    signature: string,
  ): Promise<{ token: string; master_id: string; expires_at: number }> {
    const challenge = await this.store.consumeChallenge(challengeId, `master:${masterId(chain, address)}`);
    if (chain === "stellar") {
      verifySep53(address, challenge.message, signature);
    } else {
      let recovered: string;
      try {
        recovered = await recoverMessageAddress({ message: challenge.message, signature: signature as `0x${string}` });
      } catch {
        throw err(401, "signature verification failed");
      }
      if (recovered.toLowerCase() !== address.toLowerCase()) throw err(401, "signature verification failed");
    }
    const master = await this.store.upsertMaster(chain, address);
    const { token, session } = await this.store.createSession({ kind: "master", master_id: master.id });
    return { token, master_id: master.id, expires_at: session.expires_at };
  }

  // -- runner ---------------------------------------------------------------

  async runnerChallenge(runnerId: string): Promise<Challenge> {
    const runner = await this.store.getRunner(runnerId);
    if (runner.revoked) throw err(404, `runner ${runnerId} not found`);
    const message = `Stellar Mosaic Runner Session\nRunner: ${runnerId}\nNonce: ${nonce()}`;
    const stored = await this.store.createChallenge(`runner:${runnerId}`, message);
    return { challenge_id: stored.id, message: stored.message, expires_at: stored.expires_at };
  }

  async runnerVerify(
    runnerId: string,
    challengeId: string,
    signature: string,
  ): Promise<{ token: string; runner_id: string; expires_at: number }> {
    const challenge = await this.store.consumeChallenge(challengeId, `runner:${runnerId}`);
    const runner = await this.store.getRunner(runnerId);
    if (runner.revoked) throw err(404, `runner ${runnerId} not found`);
    verifySep53(runner.auth_public_key, challenge.message, signature);
    const payload: SessionPayload = { kind: "runner", runner_id: runner.id, master_id: runner.master_id };
    const { token, session } = await this.store.createSession(payload);
    return { token, runner_id: runner.id, expires_at: session.expires_at };
  }

  // -- agent ----------------------------------------------------------------

  async agentChallenge(stellarPublicKey: string): Promise<Challenge> {
    const agent = await this.requireActiveAgent(stellarPublicKey);
    const message = `Stellar Mosaic Agent Session\nAgent: ${agent.stellar_public_key}\nNonce: ${nonce()}`;
    const stored = await this.store.createChallenge(`agent:${agent.stellar_public_key}`, message);
    return { challenge_id: stored.id, message: stored.message, expires_at: stored.expires_at };
  }

  async agentVerify(
    stellarPublicKey: string,
    challengeId: string,
    signature: string,
  ): Promise<{ token: string; agent: AgentRecord; session: AgentSessionRecord; expires_at: number }> {
    const challenge = await this.store.consumeChallenge(challengeId, `agent:${stellarPublicKey}`);
    const agent = await this.requireActiveAgent(stellarPublicKey);
    verifySep53(agent.stellar_public_key, challenge.message, signature);
    const agentSession = await this.store.createAgentSession(agent.id);
    const { token, session } = await this.store.createSession({
      kind: "agent",
      agent_id: agent.id,
      session_id: agentSession.id,
    });
    return { token, agent, session: agentSession, expires_at: session.expires_at };
  }

  private async requireActiveAgent(stellarPublicKey: string): Promise<AgentRecord> {
    const agent = await this.store.agentByStellarKey(stellarPublicKey);
    if (!agent || agent.revoked) throw err(404, "agent identity not registered");
    return agent;
  }

  // -- sessions ---------------------------------------------------------------

  async requireSession(token: string | undefined): Promise<StoredSession>;
  async requireSession<K extends StoredSession["kind"]>(
    token: string | undefined,
    kind: K,
  ): Promise<Extract<StoredSession, { kind: K }>>;
  async requireSession(token: string | undefined, kind?: StoredSession["kind"]): Promise<StoredSession> {
    if (!token) throw err(401, "missing bearer token");
    const session = await this.store.getSession(token);
    if (!session) throw err(401, "invalid or expired session");
    if (kind && session.kind !== kind) throw err(403, `this route needs a ${kind} session`);
    return session;
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.store.deleteSession(token);
  }
}
