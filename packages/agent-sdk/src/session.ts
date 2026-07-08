// AgentSession — the top-level DX for an agent process: authenticate with the derived identity,
// read attached data (transparently opening values the master sealed under this agent's dataKey),
// keep scratch state, and log the session. Logging goes over XMTP to the backend's known address
// when enabled (the default); with XMTP off, log() is a no-op that still succeeds so tests and
// dry-runs can exercise the full flow without the network.

import { AgentBackendClient } from "./backendClient.js";
import { isSealedData, openAgentData } from "./dataCrypto.js";
import type { AgentIdentity } from "./derive.js";
import type { AgentRecord, LogEnvelope } from "./types.js";

export interface SessionLogger {
  log(envelope: LogEnvelope): Promise<void>;
  close(): Promise<void>;
}

export interface StartAgentSessionOptions {
  backendUrl: string;
  identity: AgentIdentity;
  xmtp?: {
    enabled?: boolean;
    env?: "dev" | "production" | "local";
    /** Directory for the local encrypted XMTP db (default `.mosaic-agent/`). */
    dbDir?: string;
  };
  /** Injectable logger factory (tests). Defaults to the XMTP logger when xmtp is enabled. */
  createLogger?: (sessionId: string) => Promise<SessionLogger>;
}

export interface AgentSession {
  sessionId: string;
  agent: AgentRecord;
  client: AgentBackendClient;
  /** Attached data snapshot at auth time (raw values; sealed values still sealed). */
  attached: Record<string, unknown>;
  /** Attached value by key, decrypted with the identity dataKey when sealed. */
  openAttached(key: string): Promise<unknown>;
  refreshData(): Promise<{ attached: Record<string, unknown>; scratch: Record<string, unknown> }>;
  putScratch(key: string, value: unknown): Promise<void>;
  log(payload: unknown, opts?: { visibility?: "public" | "private"; kind?: "log" }): Promise<void>;
  /** Flush + session_end over the log channel, end the session on the backend, drop the token. */
  end(): Promise<void>;
}

export async function startAgentSession(opts: StartAgentSessionOptions): Promise<AgentSession> {
  const client = new AgentBackendClient(opts.backendUrl);
  const auth = await client.authenticateAgent(opts.identity);
  const xmtpEnabled = opts.xmtp?.enabled ?? true;

  let logger: SessionLogger | null = null;
  if (opts.createLogger) {
    logger = await opts.createLogger(auth.session_id);
  } else if (xmtpEnabled) {
    const info = await client.info();
    if (!info.xmtp_address) throw new Error("backend has no XMTP inbox (set xmtp.enabled: false to run without session logs)");
    const { createXmtpSessionLogger } = await import("./xmtpLogger.js");
    logger = await createXmtpSessionLogger({
      identity: opts.identity,
      backendXmtpAddress: info.xmtp_address,
      env: opts.xmtp?.env ?? info.xmtp_env,
      ...(opts.xmtp?.dbDir !== undefined ? { dbDir: opts.xmtp.dbDir } : {}),
    });
  }

  let seq = 0;
  let attached = auth.attached;
  const send = async (kind: LogEnvelope["kind"], visibility: "public" | "private", payload: unknown) => {
    if (!logger) return;
    seq += 1;
    await logger.log({
      mosaic: "agent-log/v1",
      session_id: auth.session_id,
      seq,
      at: Date.now(),
      visibility,
      kind,
      payload,
    });
  };
  await send("session_start", "private", { agent: auth.agent.id, index: auth.agent.index });

  let ended = false;
  return {
    sessionId: auth.session_id,
    agent: auth.agent,
    client,
    get attached() {
      return attached;
    },
    async openAttached(key: string): Promise<unknown> {
      const value = attached[key];
      return isSealedData(value) ? openAgentData(value, opts.identity.dataKey) : value;
    },
    async refreshData() {
      const data = await client.agentData();
      attached = Object.fromEntries(Object.entries(data.attached).map(([k, v]) => [k, v.value]));
      const scratch = Object.fromEntries(Object.entries(data.scratch).map(([k, v]) => [k, v.value]));
      return { attached, scratch };
    },
    async putScratch(key: string, value: unknown) {
      await client.putScratch(key, value);
    },
    async log(payload: unknown, logOpts?: { visibility?: "public" | "private" }) {
      await send("log", logOpts?.visibility ?? "private", payload);
    },
    async end() {
      if (ended) return;
      ended = true;
      await send("session_end", "private", null).catch(() => {});
      await logger?.close().catch(() => {});
      await client.endSession().catch(() => {});
      await client.logout().catch(() => {});
    },
  };
}
