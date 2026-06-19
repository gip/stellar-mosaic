# mosaic-backend

Web backend for Stellar Mosaic: a desk registry + fully-sponsored relayer for the `settlement`
contract. Shells out to the `stellar` CLI (the validated recipe in `scripts/0{4,6}_*.sh`).

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
`MOSAIC_DB` (default `data/mosaic.db`), `MOSAIC_ARTIFACTS` (default `artifacts/`),
`MOSAIC_READ_IDENTITY` (default `m0`).

## Endpoints

- `GET  /health`
- `GET  /desks` · `POST /desks` (deploy a new desk) · `POST /desks/import` (register existing)
- `GET  /desks/:id` · `GET /desks/:id/root` · `GET /desks/:id/book?pair=&side=`

Creating a desk generates + friendbot-funds a sponsor account, deploys a fresh settlement
contract, sets the unshield/cancel VKs, and registers the assets + pairs. Sponsor secrets are
stored in SQLite (testnet only).
