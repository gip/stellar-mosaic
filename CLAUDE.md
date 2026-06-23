# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Stellar Mosaic is a privacy-preserving DEX on Stellar/Soroban. It is **owner-anonymous and
amount-transparent**: note asset/amount, order pair/price/size, and timing are public; the owner
behind each note, the create-to-spend link, and which note a spend consumed are hidden. A trade
settles **atomically in one transaction** that verifies both sides' UltraHonk order proofs (no
per-circuit trusted setup). The order book is off-chain (lit), settlement and the note-commitment
tree are on-chain.

Read `docs/architecture.md` first — it is the entry-point design doc. Other docs:
`docs/privacy-model.md`, `docs/note-types.md`, `docs/simple-order-book.md` (the on-chain book),
`docs/base-bridge.md` (Base → Stellar shield), `docs/implementation.md` (how to build/run, the
order-proof circuit spec, storage durability, current status), `docs/e2e-testing.md` (the operator's
guide for running both testnet legs via the stateful `scripts/e2e.sh` driver), and
`docs/benchmarks.md` (all cost measurements, the 400M CPU budget, and the verifier-choice
provenance). Forward-looking design docs
for planned/unbuilt work: `docs/ui-ux.md` (WS3), `docs/noir-matching.md` (WS4 — matching in Noir +
tree-backed orders/nullifiers), `docs/shared-merkle-tree.md` (WS5 — cross-chain tree + KYC desk).

## Repository shape

There is **no root Cargo workspace** — the Rust crates are separate (different targets/toolchains:
the contract is `wasm32v1-none` no_std, the hosts are std, `bridge-prover` pins Rust 1.96 + risc0).
Build each piece from its own directory. All external deps are now fetched from the network
(crates.io + pinned git revs/tags) rather than gitignored local checkouts, so every crate —
including `contracts/settlement`, `tools/indexer`, and `bridge-prover` — builds **standalone** from a
fresh checkout. (Note: changing `bridge-prover`'s Steel source can change the guest image ID; if it
does, the committed image ID and the on-chain config must be regenerated together.)

- `circuits/{lift,unshield,cancel,join,spend,wallet}/` — Noir circuits. `lift` is the **order
  proof** (binds the full order; there is no on-chain `lift` entrypoint). `unshield` is the
  recipient-bound asset-note spend. `wallet` holds in-browser Noir helpers.
- `contracts/settlement/` — the one merged Soroban contract: custody (`shield`/`unshield`), the
  on-chain depth-32 append-only Merkle tree, the canonical nullifier registry, atomic matching
  (`settle`/`settle_exact`), and the on-chain order book (`submit_order`/`cancel_order`/`prune_expired`).
- `contracts/groth16_spike/` — RISC Zero Groth16 verifier spike for the Base bridge.
- `tools/indexer/` (crate `mosaic-indexer`) — read-only off-chain path server. Rebuilds Merkle
  membership paths from `shielded`/`settled`/`noteins` events. **Not a trust anchor** (the on-chain
  root is). Reuses the contract's exact Poseidon2 via a local Soroban host, so its roots are
  byte-identical by construction. The `witness` bin replays an event log and prints `Prover.toml`
  path witnesses (used by `tests/fixtures/regen.sh` and by wallets before proving).
- `backend/` (crate `mosaic-backend`, axum) — durable per-wallet FIFO operation queues, desk
  registry, event indexer, fully-sponsored relayer, and opaque AES-GCM wallet backups. Holds only
  public workflow state; private notes and proving stay in the browser.
- `frontend/` — Vite/React/TypeScript web client. Wallet login (Freighter), shield, order book,
  in-browser Noir proving (`@noir-lang/noir_js` + `@aztec/bb.js`).
- `evm/` — Foundry project. `MosaicBridge.sol`: the Base-side one-way peg that emits a `Shielded`
  event a RISC Zero/Steel proof later attests so Stellar mints the note.
- `bridge-prover/` — RISC Zero zkVM workspace (`host` + `methods`) that proves a Base deposit
  (state/view-call via `eth_getProof`, OP-Steel). Pulls Steel from `boundless-xyz/steel` (pinned tag),
  so it builds without an external checkout.
- `scripts/` — numbered demo/measurement scripts (see below). `docs/` — design + provenance.
- `vendor/` (gitignored) — optional local checkouts only (e.g. `stellar-risc0-verifier` for bridge
  spikes). The settlement verifier (`ultrahonk_soroban_verifier`, pinned git rev of NethermindEth's
  public repo) and `soroban-poseidon` (crates.io `26.0.0`) are now resolved by cargo, not vendored.
- `artifacts/`, `vks/` — proof/vk outputs (mostly gitignored; some VKs committed for the backend).

## Build, test, run

**Settlement contract (Soroban):**
```bash
cd contracts/settlement
cargo test --test integration   # full custody loop on the local host: real verifier, no testnet
cargo test -p settlement        # all tests incl. e2e_demo (needs fixtures from scripts/03 first)
stellar contract build --optimize   # target wasm32v1-none; output target/wasm32v1-none/release/settlement.wasm
```
The integration test (14 tests) exercises shield → atomic settle (two crossing proofs) → unshield
plus negatives (unpublished root, replay, tampered field, incompatible orders, wrong recipient).
Proof fixtures live in `contracts/settlement/tests/fixtures/` (regenerate via its `regen.sh`).

**Backend** (needs `stellar` CLI on PATH, `artifacts/settlement.wasm`, and `vks/{lift,unshield,cancel}_vk`):
```bash
cd backend
cargo run   # listens on 127.0.0.1:8787
```
Config via env: `MOSAIC_BIND`, `MOSAIC_NETWORK` (default `testnet`), `MOSAIC_DATABASE_URL`
(`postgres://...` or `sqlite://...`), `MOSAIC_ARTIFACTS`, `MOSAIC_READ_IDENTITY` (default `m0`).

**Frontend:**
```bash
cd frontend
npm run dev       # vite dev server
npm run build     # tsc -b && vite build
npm run lint      # eslint
```

**EVM (Foundry):** `cd evm && forge build && forge test`. Needs `BASE_SEPOLIA_RPC_URL` /
`BASESCAN_API_KEY` env for `base_sepolia` RPC/etherscan.

**Bridge prover:** `cd bridge-prover && cargo build` (Steel pulled from `boundless-xyz/steel` at a
pinned tag; needs the risc0 toolchain — `r0vm`/`cargo-risczero` — for the guest build).

**Scripts** (run from repo root): `01` local prove/verify · `02` legacy on-chain verifier spike ·
`03` e2e demo fixtures (local host) · `04` authoritative testnet e2e · `05`/`06`/`07` order-book
fixtures + budget · `08` web artifacts · `09` join fixtures · `10` Base-shield testnet demo.
`scripts/e2e.sh` is the stateful driver over `04`+`10` (status/show/run/regen/clean); it persists
deployed contracts/addresses to `.e2e/state.env`. See `docs/e2e-testing.md`.

## Hard invariants — do not weaken these

- **400M-instruction CPU budget per tx** (testnet and mainnet). One UltraHonk verify ≈ 80M (~20%).
  Atomic `settle` (two verifies + two proceeds inserts) measured ~230.5M (~58%). Any change that
  adds a third in-tx verify or another tree insert risks blowing the budget — check
  `docs/benchmarks.md` and re-measure.
- **`settle` trusts only verified public inputs.** The order proof binds nullifier, `asset_in`,
  `amount_in`, `asset_out`, `min_out`, `output_owner_tag`, the membership `root`, and a domain
  separator. The contract never accepts caller-supplied output commitments; proceeds are built from
  the bound `output_owner_tag`. Never add a path that takes order terms or output notes from the caller.
- **One merged contract = one nullifier registry.** Do not split custody/desk into separate
  registries (double-spend risk). The two sides of a settle must have distinct, unspent nullifiers,
  recorded before any proceeds are emitted.
- **On-chain Poseidon `compress` must stay byte-identical to the circuits** — host
  `poseidon2_permutation` with `soroban-poseidon` BN254 t=4 constants, unit-tested against Noir. The
  indexer reuses the exact same hash; the cross-check test asserts indexer root == on-chain root ==
  the root the committed proofs were generated against. Don't touch one side of this without the others.
- **Fund-critical state is persistent/instance storage only** (never temporary), TTL bumped to max
  on write, with permissionless `keep_alive` heartbeats. See `docs/implementation.md`.

## Toolchain / version pinning

- Soroban: `soroban-sdk` **26.0.1** (matched to Nethermind's verifier pin; `hazmat-crypto` feature
  exposes `poseidon2_permutation`). `stellar` CLI tested at 26.1.0.
- Bridge-prover: Rust **1.96**, RISC Zero **3.0**.
- Proof artifacts: `nargo` **1.0.0-beta.9**, `bb` **v0.87.0**. The `bb` proof format differs across
  versions, so a mismatch makes valid proofs fail verification. The committed backend VKs are bb
  0.87.0 so browser proofs (`@aztec/bb.js` 0.87.x) verify. Recipe:
  `bb prove/write_vk --scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields`.

## Conventions worth knowing

- **Trading pairs are canonical:** `register_pair(base, quote)` fixes orientation (e.g. `XLM/USDC`,
  never the reverse). SELL = give base / want quote, BUY = give quote / want base. Registering the
  reverse of an existing pair is rejected.
- **`circuits/lift` naming is historical** — it is the order proof, not a `lift` entrypoint. All 12
  of its public inputs are used on-chain (`settle` uses `[0..8]`; the book uses `order_leaf`,
  `cancel_owner_tag`, `expiry`, `partial_allowed`).
- **Per-operation VKs:** the order VK (op 1) is set at construction; `set_vk(op, vk)` registers
  others (unshield is op 2).
- **Partial fills** exist only in the on-chain order book (exact integer "lots" of the maker's price
  ratio — no change note); `settle`/`settle_exact` are full-fill.
