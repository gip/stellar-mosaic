# mosaic-backend

Web backend for Stellar Mosaic: durable per-wallet operation queues, desk registry, persistent
contract-event indexer, and fully-sponsored settlement relays. Private notes and ZK proving remain
in the browser; PostgreSQL/SQLite hold only public workflow state and opaque encrypted backups.

## Prerequisites

- `stellar` CLI (tested 26.1.0) on `PATH`.
- A funded testnet identity for read simulations (default name `m0`), or rely on per-desk sponsors.
- `artifacts/settlement.wasm` — `cd ../contracts/settlement && stellar contract build --optimize` then copy
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
`MOSAIC_DB=data/mosaic.db`), `MOSAIC_ARTIFACTS` (default `artifacts/`), `MOSAIC_VKS` (default
`vks/`), and `MOSAIC_READ_IDENTITY` (default `m0`).

### Base proving and deployment RPC

`GET /base-deployment-config` reports `Base proving/deployment RPC is not configured` until
`MOSAIC_BASE_RPC` is set. This must be a Base Sepolia RPC that serves `eth_getProof`; the public
`https://sepolia.base.org` endpoint is not sufficient. Use a provider URL such as Alchemy or Infura:

```bash
export MOSAIC_BASE_RPC=https://base-sepolia.g.alchemy.com/v2/<key>
```

The same setting enables the Base-shield worker. That worker also needs Foundry's `cast` on `PATH`
(or `MOSAIC_CAST_BIN=/path/to/cast`) and a built `bridge-prover/run-host` launcher. If you start the
backend from this directory with `cargo run`, point the prover at the repository-level workspace:

```bash
export MOSAIC_PROVER_DIR=../bridge-prover
```

Browser-paid Base bridge deployment also requires `artifacts/MosaicBridge.json` in the backend
working directory, generated from the repository root:

```bash
scripts/08_build_web_artifacts.sh
```

The backend verifies the Base Sepolia chain id, creation receipt, deployed bytecode, owner, and
catalog-derived asset mappings before configuring Stellar. The testnet verifier pins default to the
reviewed deployments and can be overridden with `MOSAIC_BASE_ROUTER`, `MOSAIC_BASE_IMAGE_ID`, and
`MOSAIC_BASE_CONFIG_ID`.

For an already configured settlement contract, `GET /desks/:id/base-shield-config` reports whether
the desk's on-chain bridge and the backend worker are ready. Without `MOSAIC_BASE_RPC`, Base shield
jobs can be queued only by mistake and will not advance.

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
- `GET  /base-deployment-config` · `POST /desks/:id/base-deployment` (canonical Base deployment)
- `GET  /desks/:id` · `GET /desks/:id/root` · `GET /desks/:id/book?pair=&side=`
- `GET  /desks/:id/base-shield-config` · `GET|POST /desks/:id/base-shields`
- `GET|PUT /wallet-backups/:backup_id` — opaque AES-GCM wallet snapshots. Updates require a
  separate write capability and generation compare-and-swap; the backend never receives note keys.

Production deployments must expose the backup endpoints only over HTTPS. Backup ciphertext is
limited to 2 MiB; SQLite stores the write-token hash, never the token itself.

Fund mutation routes require both an authenticated wallet session and a currently leased client
action. They cannot be called directly to bypass FIFO serialization. Leases last 90 seconds and are
renewed every 30 seconds while the browser proves or waits for wallet authorization.

Creating a desk requires a Stellar wallet session, generates + friendbot-funds a sponsor account, deploys a fresh settlement
contract, sets the unshield/cancel VKs, and registers the assets + pairs. Sponsor secrets are
stored in SQLite (testnet only).
