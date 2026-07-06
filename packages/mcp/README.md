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
| `base_shield_config` | (per desk) report whether Base shielding is available + the verified bridge |
| `enqueue_base_shield` | (authed) enqueue a durable Base→Stellar shield job (drift-guarded) |
| `list_base_shields` | (per desk) list Base shield jobs + their status |

## Run

```bash
pnpm --filter @mosaic/mcp build
mosaic-mcp            # stdio transport (what agents connect to)
```

Logs are JSON lines on stderr, so they are safe with stdio MCP transport. Set `MOSAIC_LOG=debug`
or `MOSAIC_LOG_LEVEL=debug` for verbose tool logs; supported levels are `debug`, `info`, `warn`,
`error`, and `silent`. The default is `warn`.

Base shielding is gated by configuration; without it `base_shield_config` reports `worker_disabled`
and only authentication + local features are available. Enqueued jobs are advanced by a **durable
in-process worker** that drives a **remote prove service** (the `backend/` crate) by submit + poll —
proving (~10 min) never holds an HTTP connection open. To enable it, set:

| Env | Meaning |
| --- | --- |
| `MOSAIC_PROVE_SERVICE_URL` | base URL of the remote prove service (`backend/`) |
| `MOSAIC_PROVE_TOKEN` | shared bearer token; must match the prove service's `MOSAIC_PROVER_TOKEN` |
| `MOSAIC_BASE_RPC` | Base RPC URL (direct `eth_getBlockByNumber("finalized")` finality check) |
| `MOSAIC_RPC` / `MOSAIC_NETWORK_PASSPHRASE` | Stellar RPC + passphrase the mint is submitted against |

The worker advances each job `proving → awaiting_finality → minting → active|failed`: submit/poll the
prove service, wait for Base finality, then `attest_base_block` + `shield_from_base` via the desk
sponsor (from the store). The Base deposit itself must be made with the note's owner tag (the browser
derives the tag, deposits, then enqueues by `deposit_id`).

**Durability.** Jobs (including proof artifacts) live in the SQLite store, so a restart resumes each
job from its persisted stage; the prove service caches completed proofs on disk, so re-submits are
no-ops. Transient step failures (a prove-service error, a Stellar RPC/CLI hiccup during mint) retry
in-stage with a per-stage attempt cap before the job goes `failed`; a mint rejected by the contract
as `DepositAlreadyProcessed` (#27) means an earlier attempt landed (e.g. a crash between the mint
and the status write) and resolves the job to `active`. Two caveats: the default
`MOSAIC_DATABASE_URL` (`sqlite://./mosaic-mcp.db`) is cwd-relative — set an absolute path in
deployment or a different cwd silently starts an empty store — and the worker assumes a single MCP
process per database (there is no cross-process job lease).

## Server-side desk deployment (Trusted mode)

In Trusted mode the server deploys **everything** for `create_desk`: the Stellar settlement contract
(a fresh friendbot-funded sponsor keypair) and — for desks with Base-backed assets — the
`MosaicBridge` on Base Sepolia, deployed and owned by a single operator-funded key. The browser never
signs; the server records the deploy activity (with tx hashes) which the wallet pulls via
`activity_since`. A failed bridge deploy leaves the Stellar desk in place and is retried with
`retry_base_deployment`.

| Env | Meaning |
| --- | --- |
| `MOSAIC_BASE_RPC` | Base Sepolia RPC URL (also used by the Base-shield finality check) |
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
