#!/usr/bin/env node
// `mosaic-mcp` — run the Mosaic MCP server over stdio (the transport agents use). The Base-shield
// worker is enabled by pointing at the remote prove service via the environment
// (MOSAIC_PROVE_SERVICE_URL, MOSAIC_PROVE_TOKEN, MOSAIC_BASE_RPC, ...); without it, Base shielding is
// simply unavailable and everything else works.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMosaicMcpServer } from "./server.js";
import { baseShieldConfigFromEnv } from "./baseShield.js";
import { startBaseShieldWorker } from "./baseShieldWorker.js";
import { startHttpServer } from "./http.js";
import { openMosaicStore } from "./store.js";
import { configureMcpLogging } from "./logging.js";

const logger = configureMcpLogging();

if (process.argv.includes("--http")) {
  const server = await startHttpServer({ baseShield: baseShieldConfigFromEnv(), logger });
  process.stderr.write(`mosaic-mcp HTTP listening at ${server.url}\n`);
} else {
  const baseShield = baseShieldConfigFromEnv();
  const store = openMosaicStore(process.env.MOSAIC_DATABASE_URL);
  const server = createMosaicMcpServer({ baseShield, store, logger });
  if (baseShield) {
    startBaseShieldWorker(store, baseShield, {
      logger: { info: (m) => logger.info?.(m), warn: (m) => logger.warn?.(m) },
    });
  }
  await server.connect(new StdioServerTransport());
}
