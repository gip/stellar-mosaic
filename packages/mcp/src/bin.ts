#!/usr/bin/env node
// `mosaic-mcp` — run the Mosaic MCP server over stdio (the transport agents use). Base-shield config
// is read from the environment (MOSAIC_PROVER_DIR, MOSAIC_BASE_RPC, MOSAIC_BRIDGE_ADDRESS,
// MOSAIC_SPONSOR_SECRET, ...); without it, only authentication is available.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMosaicMcpServer } from "./server.js";
import { baseShieldConfigFromEnv } from "./baseShield.js";
import { startHttpServer } from "./http.js";
import { openMosaicStore } from "./store.js";
import { configureMcpLogging } from "./logging.js";

const logger = configureMcpLogging();

if (process.argv.includes("--http")) {
  const server = await startHttpServer({ baseShield: baseShieldConfigFromEnv(), logger });
  process.stderr.write(`mosaic-mcp HTTP listening at ${server.url}\n`);
} else {
  const server = createMosaicMcpServer({
    baseShield: baseShieldConfigFromEnv(),
    store: openMosaicStore(process.env.MOSAIC_DATABASE_URL),
    logger,
  });
  await server.connect(new StdioServerTransport());
}
