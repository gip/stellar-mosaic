// @mosaic/mcp — programmatic entry. `mosaic-mcp` (bin.ts) runs it over stdio; embed
// createMosaicMcpServer in your own transport (e.g. Streamable HTTP) for the browser.
export * from "./auth.js";
export * from "./baseShield.js";
export * from "./server.js";
