#!/usr/bin/env node
// mosaic-agent-backend: env config → sqlite store → HTTP API + XMTP inbox worker.

import { agentBackendConfigFromEnv } from "./config.js";
import { startAgentBackend } from "./http.js";

const config = agentBackendConfigFromEnv();
const handle = await startAgentBackend({
  config,
  logger: {
    info: (msg) => console.log(`[agent-backend] ${msg}`),
    warn: (msg) => console.warn(`[agent-backend] ${msg}`),
  },
});
console.log(`[agent-backend] listening on ${handle.url} (db ${config.databaseUrl}, network "${config.networkPassphrase}")`);
if (handle.xmtpAddress) console.log(`[agent-backend] known XMTP address: ${handle.xmtpAddress}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void handle.close().then(() => process.exit(0));
  });
}
