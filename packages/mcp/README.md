# @mosaic/mcp (`mosaic-mcp`)

The authenticated **MCP server** for Stellar Mosaic — the optional "backend." Minimal first release:
**wallet authentication** + the **Base→Stellar shield** flow. Those are the only pieces that
genuinely need a server (RISC Zero/Steel proving + a funded relayer + finality polling); everything
else — shield, orders, unshield, cancel, note tracking — runs locally via `@mosaic/sdk`.

## Tools

| Tool | Purpose |
| --- | --- |
| `auth_challenge` | issue a message for a Stellar address to sign |
| `auth_verify` | verify the ed25519 signature, return a session token |
| `base_shield` | (authed) prove a Base deposit, await finality, attest, and mint the note |

## Run

```bash
pnpm --filter @mosaic/mcp build
mosaic-mcp            # stdio transport (what agents connect to)
```

Logs are JSON lines on stderr, so they are safe with stdio MCP transport. Set `MOSAIC_LOG=debug`
or `MOSAIC_LOG_LEVEL=debug` for verbose tool logs; supported levels are `debug`, `info`, `warn`,
`error`, and `silent`. The default is `warn`.

`base_shield` is gated by configuration; without it the tool returns a clear "not configured" error
and only authentication is available. To enable it, set:

| Env | Meaning |
| --- | --- |
| `MOSAIC_PROVER_DIR` | directory containing the `bridge-prover` `run-host` binary |
| `MOSAIC_BASE_RPC` | Base RPC URL |
| `MOSAIC_BRIDGE_ADDRESS` | `MosaicBridge` contract address on Base |
| `MOSAIC_SPONSOR_SECRET` | desk sponsor secret (signs the mint) |
| `MOSAIC_CAST_BIN` | Foundry `cast` (default `cast`), `MOSAIC_RPC`, `MOSAIC_NETWORK_PASSPHRASE` |

The pipeline mirrors `backend/src/base_shield.rs`: prove (in the `eth_getProof` window) → await Base
finality → attest block hash → `shield_from_base` via the sponsor.

## Server-side desk deployment (Trusted mode)

In Trusted mode the server deploys **everything** for `create_desk`: the Stellar settlement contract
(a fresh friendbot-funded sponsor keypair) and — for desks with Base-backed assets — the
`MosaicBridge` on Base Sepolia, deployed and owned by a single operator-funded key. The browser never
signs; the server records the deploy activity (with tx hashes) which the wallet pulls via
`activity_since`. A failed bridge deploy leaves the Stellar desk in place and is retried with
`retry_base_deployment`.

| Env | Meaning |
| --- | --- |
| `MOSAIC_BASE_RPC` | Base Sepolia RPC URL (also used by `base_shield`) |
| `MOSAIC_BASE_DEPLOYER_KEY` | operator EVM private key (32-byte hex, funded with Base Sepolia ETH) that deploys and owns bridges |
| `MOSAIC_BASE_ROUTER_ID` | RISC Zero router id bound into `configure_base_bridge` (defaults to the pinned Base Sepolia router) |

`base_deployment_config` reports `server_deploys: true` once `MOSAIC_BASE_RPC` and
`MOSAIC_BASE_DEPLOYER_KEY` are set; without them a desk that needs a bridge is rejected up front.

## Clients

- `@mosaic/sdk/mcp-client` — `createMcpClient({ url })` returns an `McpClient` (Streamable HTTP) that
  `MosaicClient.shieldFromBase` and the CLI's `mosaic base-shield --mcp <url>` use.
- The server is also usable programmatically: `createMosaicMcpServer(opts)` + your own transport
  (e.g. Streamable HTTP for the browser).

## Auth model

A client signs a server-issued challenge with its Stellar key; the server verifies with the address's
public key (raw ed25519 — works with `SecretKeySigner` for CLI/agents). Browser Freighter signing
prefixes messages, so a Freighter-backed `signMessage` needs prefix-aware verification (follow-up).
