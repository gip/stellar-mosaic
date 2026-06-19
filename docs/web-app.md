# Web app: desks, shield, order book

A web frontend + Rust backend on top of the `settlement` contract. Users browse **desks**, log in
with a Stellar wallet, shield USDC/XLM, and place limit orders — with ZK proofs generated in the
browser and transactions relayed fully-sponsored.

- `frontend/` — Vite + React + TS, Freighter wallet, IndexedDB private notes, in-browser proving
  (`noir_js` + `@aztec/bb.js`). See `frontend/README.md`.
- `backend/` — Rust (axum): desk registry (SQLite), desk deploy pipeline, indexer-backed membership
  paths, and fully-sponsored relays. See `backend/README.md`.

## Desk model

A **desk** is its own deployed `settlement` contract + a friendbot-funded sponsor ("main") account
+ its registered assets and pairs. `POST /desks` runs the full deploy pipeline (mirrors
`scripts/06_book_budget_testnet.sh`): generate + fund sponsor → deploy wasm with the lift VK + admin
→ set unshield/cancel VKs → register assets (`"native"` → XLM SAC) and pairs.

## Trust / privacy boundary

- Note secrets (`sk`, `rho`) never leave the browser; owner tags, nullifiers, and order leaves are
  derived in-browser via tiny Noir helpers, and order proofs are generated in-browser. The backend
  only relays finished proofs.
- `shield` moves the user's own tokens, so it is user-signed (Freighter). `submit_order` /
  `unshield` / `cancel_order` are relayer-submittable (the proof is the spend authority), so the
  desk sponsor is the sole source/fee payer = fully sponsored.

## Proof compatibility

`bb.js` (`{ keccak: true }`) produces a full UltraHonk proof + public inputs that the on-chain
Nethermind verifier accepts against the committed VKs (`backend/vks/`, generated with `bb` v0.87.0).
Verified directly: a browser-generated lift proof verifies against the deployed VK, and a freshly
shielded note proves in-JS and rests on the on-chain book via the sponsored relay.

## Build artifacts

`scripts/08_build_web_artifacts.sh` builds `settlement.wasm` (→ `backend/artifacts/`) and compiles
the lift + wallet helper circuits (→ `frontend/public/circuits/`).

## Run

```bash
./scripts/08_build_web_artifacts.sh         # once / after circuit changes
(cd backend && cargo run)                   # 127.0.0.1:8787
(cd frontend && npm install && npm run dev) # http://localhost:5173
```

## Not yet wired in the UI

The backend exposes `/relay/unshield` and `/relay/cancel` (with the unshield/cancel circuits and
VKs in place), but the frontend does not yet build those proofs — withdraw + cancel are the natural
next UI additions. Sponsored `shield` via Freighter auth-entry signing (vs. user-paid fee) is also
a follow-up.
