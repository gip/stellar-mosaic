# mosaic-backend

Web backend for Stellar Mosaic: durable per-wallet operation queues, desk registry, persistent
contract-event indexer, and fully-sponsored settlement relays. Private notes and ZK proving remain
in the browser; PostgreSQL/SQLite hold only public workflow state and opaque encrypted backups.

## Prerequisites

- `stellar` CLI (tested 26.1.0) on `PATH`.
- A funded testnet identity for read simulations (default name `m0`), or rely on per-desk sponsors.
- `artifacts/settlement.wasm` — `cd ../contracts/settlement && stellar contract build` then copy
  `target/wasm32v1-none/release/settlement.wasm` to `artifacts/settlement.wasm` (git-ignored;
  rebuild on a fresh checkout).
- `vks/{lift,unshield,cancel}_vk` — committed; copied from the contract test fixtures
  (`tests/fixtures/book/vk`, `demo/unshield_vk`, `book/cancel_vk`). Generated with `bb` v0.87.0,
  so browser proofs (`@aztec/bb.js` 0.87.x) verify against them.

## Run

```bash
cargo run            # listens on 127.0.0.1:8787
```

Config via env: `MOSAIC_BIND`, `MOSAIC_NETWORK` (default `testnet`), `MOSAIC_STELLAR_BIN`,
`MOSAIC_DATABASE_URL` (`postgres://...` in production or `sqlite://...`; defaults from the legacy
`MOSAIC_DB=data/mosaic.db`), `MOSAIC_ARTIFACTS` (default `artifacts/`),
`MOSAIC_READ_IDENTITY` (default `m0`).

PostgreSQL is required for horizontally-scaled production deployments. SQLite uses a one-connection
pool and remains supported for local development and tests. Existing SQLite desk and backup tables
are migrated in place.

## Endpoints

- `GET  /health`
- `POST /auth/challenges` · `POST|DELETE /auth/sessions` · `GET /auth/session`
- `POST|GET /operations` · `GET /operations/:id` · `POST /operations/:id/cancel`
- `GET /operations/events` — durable SSE stream with `Last-Event-ID` resume
- `POST /client-actions/next` and leased heartbeat/complete/fail routes
- `GET  /desks` · `POST /desks` (deploy a new desk) · `POST /desks/import` (register existing)
- `GET  /desks/:id` · `GET /desks/:id/root` · `GET /desks/:id/book?pair=&side=`
- `GET|PUT /wallet-backups/:backup_id` — opaque AES-GCM wallet snapshots. Updates require a
  separate write capability and generation compare-and-swap; the backend never receives note keys.

Production deployments must expose the backup endpoints only over HTTPS. Backup ciphertext is
limited to 2 MiB; SQLite stores the write-token hash, never the token itself.

Fund mutation routes require both an authenticated wallet session and a currently leased client
action. They cannot be called directly to bypass FIFO serialization. Leases last 90 seconds and are
renewed every 30 seconds while the browser proves or waits for wallet authorization.

Creating a desk generates + friendbot-funds a sponsor account, deploys a fresh settlement
contract, sets the unshield/cancel VKs, and registers the assets + pairs. Sponsor secrets are
stored in SQLite (testnet only).
