# @mosaic/sdk

Portable TypeScript SDK for **Stellar Mosaic** — the privacy-preserving DEX on Stellar/Soroban.
The same protocol logic runs in the **browser** and in **Node**, behind environment adapters, so a
web app, a CLI, an agent, or the MCP server can all drive the protocol from one code path.

## Status

Phase 1 scaffold. This package currently defines the **public surface**: domain types
(`./src/types.ts`), the environment **ports** (`./src/ports.ts`), and the high-level
`MosaicClient` interface (`./src/index.ts`). Concrete logic + adapters are filled in over the
plan's later phases (see `/Users/gilles/.claude/plans/we-need-to-restructure-glowing-iverson.md`).

## Design: ports & adapters

The core is parameterized by injected ports; adapters implement them per environment:

| Port | Browser adapter | Node adapter |
| --- | --- | --- |
| `StellarSigner` / `EthSigner` | Freighter / injected EVM wallet | raw secret key / viem |
| `NoteStore` | IndexedDB (`idb`) | SQLite (`better-sqlite3`) |
| `NoteSource` (paths) | local WASM NoteTree (`fetch`) | local WASM NoteTree (`fs`) |
| `Submitter` | DirectSubmitter (Freighter) | DirectSubmitter (secret key) |
| `Funder` / `Deployer` | — | Friendbot / stellar-sdk |
| `McpClient` (optional) | Streamable-HTTP | Streamable-HTTP / stdio |

**Fully-local is the default.** An `McpClient` is only required for the Base→Stellar shield flow
(server-side RISC Zero proving) and authenticated server features.

## Entry points

- `@mosaic/sdk` — core types, ports, `MosaicClient`.
- `@mosaic/sdk/browser` — `createBrowserClient(...)`.
- `@mosaic/sdk/node` — `createNodeClient(...)`.
- `@mosaic/sdk/mcp-client` — `createMcpClient(...)`.
- `@mosaic/sdk/assets` — self-contained protocol artifacts (circuits, VKs, wasm, manifest).

## Build

```bash
# from the repo root (npm workspaces)
npm run build:sdk
```
