#!/usr/bin/env node
// `mosaic-mcp` — run the Mosaic MCP server over stdio (the transport agents use). Base-shield config
// is read from the environment (MOSAIC_PROVER_DIR, MOSAIC_BASE_RPC, MOSAIC_BRIDGE_ADDRESS,
// MOSAIC_SPONSOR_SECRET, ...); without it, only authentication is available.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMosaicMcpServer } from "./server.js";
import { baseShieldConfigFromEnv } from "./baseShield.js";

const server = createMosaicMcpServer({ baseShield: baseShieldConfigFromEnv() });
await server.connect(new StdioServerTransport());
