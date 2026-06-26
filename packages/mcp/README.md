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
npm -w @mosaic/mcp run build
mosaic-mcp            # stdio transport (what agents connect to)
```

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

## Clients

- `@mosaic/sdk/mcp-client` — `createMcpClient({ url })` returns an `McpClient` (Streamable HTTP) that
  `MosaicClient.shieldFromBase` and the CLI's `mosaic base-shield --mcp <url>` use.
- The server is also usable programmatically: `createMosaicMcpServer(opts)` + your own transport
  (e.g. Streamable HTTP for the browser).

## Auth model

A client signs a server-issued challenge with its Stellar key; the server verifies with the address's
public key (raw ed25519 — works with `SecretKeySigner` for CLI/agents). Browser Freighter signing
prefixes messages, so a Freighter-backed `signMessage` needs prefix-aware verification (follow-up).
