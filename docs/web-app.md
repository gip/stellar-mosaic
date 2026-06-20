# Web app: desks, shield, order book

A web frontend + Rust backend on top of the `settlement` contract. Fund actions are durable,
high-level operations serialized per wallet/network. The backend records progress, persists chain
events, and controls submission; the browser retains private note selection, signatures, and ZK
proving through leased client actions.

- `frontend/` — Vite + React + TS, Freighter wallet, IndexedDB private notes, in-browser proving
  (`noir_js` + `@aztec/bb.js`). See `frontend/README.md`.
- `backend/` — Rust (axum): PostgreSQL/SQLite repository, wallet authentication, operation queue,
  durable indexer, membership paths, SSE updates, and sponsored relays. See `backend/README.md`.

## Desk model

A **desk** is its own deployed `settlement` contract + a friendbot-funded sponsor ("main") account
+ its registered assets and pairs. `POST /desks` runs the full deploy pipeline (mirrors
`scripts/06_book_budget_testnet.sh`): generate + fund sponsor → deploy wasm with the lift VK + admin
→ set unshield/cancel VKs → register assets (`"native"` → XLM SAC) and pairs.

## Trust / privacy boundary

- Plaintext note secrets (`sk`, `rho`) never leave the browser; owner tags, nullifiers, order leaves,
  and proofs are generated in-browser. Freighter `signMessage` deterministically unlocks an
  HKDF-derived recovery key; the backend stores only an opaque AES-GCM snapshot and a write-token
  hash. New note secrets are uploaded before their transaction is submitted.
- The backend is not given the wallet's owned-note inventory. Coin selection and split/join planning
  remain client-private. Each action stages output secrets and reservation state in the encrypted
  backup before submission.
- Fund mutation endpoints require a wallet session plus the live client-action lease at the head of
  that wallet's FIFO queue; direct relay calls cannot bypass serialization. Progress events are
  persisted and replayed over SSE.
- `submit_order` / `unshield` / `cancel_order` are relayer-submittable (the proof is the spend
  authority), so the desk sponsor is the sole source/fee payer = fully sponsored.
- `shield` moves the user's own tokens, so it needs the user's authorization — but it is **also
  fully sponsored** via Soroban auth-entry signing: the frontend builds the tx with the sponsor as
  source, simulates to get the `Address(user)` auth entry, the user signs **only that entry** in
  Freighter (`signAuthEntry`, verified by `authorizeEntry`), and the backend adds the sponsor's
  envelope signature (`stellar tx sign`/`tx send`). The user pays no fee and manages no sequence;
  the signed entry binds the exact invocation, so the sponsor cannot redirect or replay it.

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
(cd frontend && pnpm install && pnpm dev)   # http://localhost:5173
```

Unshield, join/split assembly, and cancel proofs are generated in-browser and sent through their
fully-sponsored relay endpoints.
