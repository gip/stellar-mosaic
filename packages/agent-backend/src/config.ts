// Env-driven config, mirroring the Rust backend's and the MCP's style: sensible defaults, and a
// missing XMTP identity disables only the inbox worker (the HTTP API still runs).

export interface AgentBackendConfig {
  bind: string;
  databaseUrl: string;
  networkPassphrase: string;
  corsOrigins: string[];
  xmtp: {
    /** 0x eth private key = the backend's known XMTP identity; unset ⇒ inbox disabled. */
    key?: `0x${string}`;
    env: "dev" | "production" | "local";
    dbPath: string;
    /** 0x 32-byte hex encryption key for the local XMTP db; required with `key`. */
    dbKey?: `0x${string}`;
  };
}

export function agentBackendConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AgentBackendConfig {
  const xmtpEnv = env.MOSAIC_AGENT_XMTP_ENV ?? "dev";
  if (xmtpEnv !== "dev" && xmtpEnv !== "production" && xmtpEnv !== "local") {
    throw new Error(`MOSAIC_AGENT_XMTP_ENV must be dev|production|local, got ${xmtpEnv}`);
  }
  return {
    bind: env.MOSAIC_AGENT_BIND ?? "127.0.0.1:8791",
    databaseUrl: env.MOSAIC_AGENT_DATABASE_URL ?? "sqlite://./mosaic-agent-backend.db",
    networkPassphrase: env.MOSAIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    corsOrigins: (env.MOSAIC_AGENT_CORS_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    xmtp: {
      ...(env.MOSAIC_AGENT_XMTP_KEY ? { key: env.MOSAIC_AGENT_XMTP_KEY as `0x${string}` } : {}),
      env: xmtpEnv,
      dbPath: env.MOSAIC_AGENT_XMTP_DB ?? "./mosaic-agent-xmtp.db3",
      ...(env.MOSAIC_AGENT_XMTP_DB_KEY ? { dbKey: env.MOSAIC_AGENT_XMTP_DB_KEY as `0x${string}` } : {}),
    },
  };
}
