// Shared shapes between the agent SDK and the agent backend. The backend imports these types (it
// depends on this package), so the wire format is defined exactly once.

/** Which wallet kind identifies the master. */
export type MasterChain = "stellar" | "ethereum";

/** The master wallet an agent tree is derived from. `address` is the G... strkey for Stellar or
 *  the EIP-55 checksummed 0x address for Ethereum. `networkPassphrase` is always the *Stellar*
 *  network the agents operate on, even for an Ethereum master. */
export interface MasterRef {
  chain: MasterChain;
  address: string;
  networkPassphrase: string;
}

/** Public-only registration payload for one derived agent identity. Private keys never appear
 *  here and never reach the backend. */
export interface AgentIdentityDescriptor {
  derivation_version: 1;
  master_chain: MasterChain;
  master_address: string;
  network_passphrase: string;
  index: number;
  stellar_public_key: string;
  eth_address: `0x${string}`;
  name?: string;
  metadata?: Record<string, unknown>;
}

/** The reserved `agent-config` attached-data value, edited on the web and consumed by the daemon
 *  and the runtime. The provider API key is deliberately absent — it travels only via env at
 *  launch time. */
export interface AgentConfig {
  version: 1;
  prompt: { preset?: string; custom?: string };
  provider: "openai" | "anthropic";
  model: string;
  params?: {
    maxTurns?: number;
    timeoutMinutes?: number;
    webSearch?: boolean;
    logVisibility?: "public" | "private";
  };
  /** Who this agent may talk to over XMTP — snapshots of other registered identities. */
  peers?: { name: string; eth_address: `0x${string}`; stellar_public_key: string }[];
  /** The desk's asset/pair universe (asset ids assigned by declaration order, starting at 1; no
   *  issuer = the native lumen). Required for trading; who actually deploys is negotiated. */
  desk?: {
    assets: { symbol: string; issuer?: string }[];
    pairs: { base: string; quote: string }[];
  };
  /** Stellar endpoint overrides (defaults: public testnet endpoints). */
  network?: { horizonUrl?: string; rpcUrl?: string; friendbotUrl?: string };
}

/** One agent's sealed key material for one runner: ECIES-style X25519 + AES-256-GCM over the
 *  32-byte agent root. All fields hex. */
export interface SealedRootEnvelope {
  v: 1;
  epk: string;
  nonce: string;
  ct: string;
}

/** A value encrypted under an agent's data key (AES-256-GCM); the backend stores it opaquely. */
export interface SealedData {
  mosaic_sealed: 1;
  nonce: string;
  ct: string;
}

/** XMTP session-log message: one JSON text DM from an agent to the backend's known address. */
export interface LogEnvelope {
  mosaic: "agent-log/v1";
  session_id: string;
  /** 1-based, monotonic per session, assigned by the sender. */
  seq: number;
  /** Sender clock, ms since epoch. */
  at: number;
  visibility: "public" | "private";
  kind: "session_start" | "log" | "session_end";
  payload: unknown;
}

/** A stored log entry as served by the backend. `cursor` is the arrival-order id used for
 *  pagination; ordering within a session is by `seq`. */
export interface LogEntry {
  cursor: number;
  session_id: string;
  agent_id: string;
  seq: number;
  at: number;
  visibility: "public" | "private";
  kind: LogEnvelope["kind"];
  payload: unknown;
  received_at: number;
}

/** Backend record for a registered agent identity. */
export interface AgentRecord {
  id: string;
  master_id: string;
  index: number;
  stellar_public_key: string;
  eth_address: `0x${string}`;
  name?: string;
  metadata?: Record<string, unknown>;
  descriptor: AgentIdentityDescriptor;
  desired_state: "running" | "stopped";
  revoked: boolean;
  created_at: number;
}

/** Backend record for a registered runner (the MOSAIC_IDENTITY credential's public half). */
export interface RunnerRecord {
  id: string;
  master_id: string;
  name?: string;
  auth_public_key: string;
  seal_public_key: string;
  runtime_version: string;
  revoked: boolean;
  last_seen?: number;
  instance_id?: string;
  created_at: number;
}

/** Backend record for one agent session (created at agent auth; its id is the XMTP session_id). */
export interface AgentSessionRecord {
  id: string;
  agent_id: string;
  started_at: number;
  ended_at?: number;
  last_log_at?: number;
  log_count: number;
}

/** What the daemon reconciles against: the runner's view of every agent under its master. */
export interface RunnerState {
  runner: { id: string; runtime_version: string };
  agents: {
    agent: AgentRecord;
    config: AgentConfig | null;
    sealed_root: SealedRootEnvelope | null;
  }[];
}
