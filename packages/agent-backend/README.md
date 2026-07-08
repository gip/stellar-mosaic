# @mosaic/agent-backend

Standalone MCP service behind the Mosaic agents feature: master/runner/agent auth, the
agent-identity registry, sealed key bundles, per-agent data (`attached` / `scratch`), and XMTP
session-log ingest + serving. It copies the MCP server's patterns (`node:sqlite` store with a
memory twin, SEP-0053 challenge auth, Streamable-HTTP MCP transport at `/mcp`) but shares no
runtime or database with it. The backend stores **public keys and ciphertext only** — it can never
run or impersonate an agent.

## Run

```
MOSAIC_AGENT_XMTP_KEY=0x... MOSAIC_AGENT_XMTP_DB_KEY=0x... pnpm --filter @mosaic/agent-backend start
```

Env (all optional unless noted): `MOSAIC_AGENT_BIND` (default `127.0.0.1:8791`),
`MOSAIC_AGENT_DATABASE_URL` (`sqlite://./mosaic-agent-backend.db`), `MOSAIC_NETWORK_PASSPHRASE`
(testnet default), `MOSAIC_AGENT_CORS_ORIGIN`, transport knobs (`MOSAIC_AGENT_MAX_BODY_BYTES`,
`MOSAIC_AGENT_MCP_TRANSPORT_TTL_MS`, `MOSAIC_AGENT_MCP_TOOL_TIMEOUT_MS`,
`MOSAIC_AGENT_MCP_SLOW_TOOL_MS`), and the XMTP identity: `MOSAIC_AGENT_XMTP_KEY` (0x eth key = the
backend's **known XMTP address**), `MOSAIC_AGENT_XMTP_DB_KEY` (0x 32-byte hex),
`MOSAIC_AGENT_XMTP_ENV` (`dev`), `MOSAIC_AGENT_XMTP_DB`. Without the XMTP vars the MCP API still
runs; only log ingest is disabled (the `info` tool reports `xmtp_address: null`).

## API sketch

Everything is an MCP tool on `POST /mcp` (Streamable HTTP; clients use `AgentBackendClient` from
`@mosaic/agent-sdk`). Auth is a `session` token argument on every authenticated tool, minted by the
per-principal challenge/verify pairs; failures carry a typed error body whose `status` mirrors the
old REST codes (401/403/404/409/400).

- `info` — known XMTP address, network, derivation version (open).
- `master_auth_challenge` / `master_auth_verify` — master auth: Stellar SEP-0053 or Ethereum
  EIP-191; `logout` for any principal.
- Master scope: `register_agent`, `list_agents`, `get_agent`, `revoke_agent`, `set_desired_state`,
  attached data (`put_attached_data` / `delete_attached_data` / `agent_data_of`, incl. the reserved
  `agent-config` key), `agent_sessions`, runners (`register_runner`, `list_runners`,
  `update_runner`, `revoke_runner`), `put_sealed_root`, `master_logs`, `session_logs`.
- Runner scope: `runner_auth_challenge` / `runner_auth_verify`, `runner_state` (agents + configs +
  sealed bundles), `runner_heartbeat` (detects two daemons on one credential).
- Agent scope: `agent_auth_challenge` / `agent_auth_verify` (creates the session whose id keys XMTP
  log envelopes), `agent_data`, `put_scratch`, `delete_scratch`, `end_agent_session`.
- Public: `public_logs`, also served as plain REST `GET /v1/logs/public` — the unauthenticated,
  browser-linkable feed of public log entries. `GET /healthz` stays REST too.

Log ingest: agents DM `agent-log/v1` JSON envelopes to the known XMTP address; the inbox worker
validates the sender's eth identity against the registry, checks the session belongs to that
agent, and stores entries idempotently (`UNIQUE(session_id, seq)`). Test: `pnpm test` (offline).
