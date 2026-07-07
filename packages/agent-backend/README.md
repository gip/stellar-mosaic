# @mosaic/agent-backend

Standalone HTTP service behind the Mosaic agents feature: master/runner/agent auth, the
agent-identity registry, sealed key bundles, per-agent data (`attached` / `scratch`), and XMTP
session-log ingest + serving. It copies the MCP server's patterns (`node:sqlite` store with a
memory twin, SEP-0053 challenge auth, bare `node:http`) but shares no runtime or database with it.
The backend stores **public keys and ciphertext only** — it can never run or impersonate an agent.

## Run

```
MOSAIC_AGENT_XMTP_KEY=0x... MOSAIC_AGENT_XMTP_DB_KEY=0x... pnpm --filter @mosaic/agent-backend start
```

Env (all optional unless noted): `MOSAIC_AGENT_BIND` (default `127.0.0.1:8791`),
`MOSAIC_AGENT_DATABASE_URL` (`sqlite://./mosaic-agent-backend.db`), `MOSAIC_NETWORK_PASSPHRASE`
(testnet default), `MOSAIC_AGENT_CORS_ORIGIN`, and the XMTP identity: `MOSAIC_AGENT_XMTP_KEY`
(0x eth key = the backend's **known XMTP address**), `MOSAIC_AGENT_XMTP_DB_KEY` (0x 32-byte hex),
`MOSAIC_AGENT_XMTP_ENV` (`dev`), `MOSAIC_AGENT_XMTP_DB`. Without the XMTP vars the HTTP API still
runs; only log ingest is disabled (`/v1/info.xmtp_address` = null).

## API sketch

- `GET /v1/info` — known XMTP address, network, derivation version (open).
- `POST /v1/auth/{challenge,verify}` — master auth: Stellar SEP-0053 or Ethereum EIP-191.
- Master scope: `/v1/agents` CRUD (register descriptors, revoke, desired-state), attached data
  (`/v1/agents/:id/data/:key`, incl. the reserved `agent-config`), `/v1/runners` (register/revoke
  runner credentials), `/v1/agents/:id/sealed-keys/:runnerId`, `/v1/logs`, `/v1/sessions/:id/logs`.
- Runner scope: `/v1/runner/auth/*`, `/v1/runner/state` (agents + configs + sealed bundles),
  `/v1/runner/heartbeat` (detects two daemons on one credential).
- Agent scope: `/v1/agent/auth/*` (creates the session whose id keys XMTP log envelopes),
  `/v1/agent/data`, `/v1/agent/scratch/:key`, `/v1/agent/session/end`.
- Public: `GET /v1/logs/public` — the unauthenticated feed of public log entries.

Log ingest: agents DM `agent-log/v1` JSON envelopes to the known XMTP address; the inbox worker
validates the sender's eth identity against the registry, checks the session belongs to that
agent, and stores entries idempotently (`UNIQUE(session_id, seq)`). Test: `pnpm test` (offline).
