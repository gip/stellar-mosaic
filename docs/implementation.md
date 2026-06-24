# Implementation: how it's built, how to run it

The concrete implementation reference: how to build and run the stack, the order-proof circuit spec,
storage durability, and the status of what's left. Design rationale is in `architecture.md`;
measurements are in `benchmarks.md`.

> **WS4 update.** Matching moved off the contract into the `match` circuit + permissionless
> `settle_match` (1 taker × ≤3 makers, full-fill makers + taker remainder), and orders + nullifiers
> are now **tree-backed**: a depth-32 order-commitment tree plus an indexed-merkle-tree (IMT)
> nullifier accumulator proven in-circuit (one root CAS on-chain). The atomic `settle`/`settle_exact`
> and the on-chain `Vec` book (`submit_order`/`prune_expired`) are **removed**; the book is now
> event-derived. Sections below describing those are **superseded** — see `noir-matching.md` for the
> current model and the contract source for the exact public-input layouts. The build/run,
> storage-durability, and toolchain sections remain current.

## Getting started

### Local prove + contract tests (no testnet)

```bash
./scripts/01_build_prove.sh                      # local prove/verify half
cd contracts/settlement && cargo test            # full WS4 suite on the local Soroban host
```

`cargo test` runs the full suite (**43 local tests**: real UltraHonk proofs on the Soroban host) —
`tests/ws4.rs` (shield → place_order, and shield×2 → place×2 → `settle_match`), `tests/integration.rs`
(asset/pair registration + shield validation + place_order/settle_match/unshield negatives:
unknown root, replay, tampered field, bad PI length, missing VK, wrong recipient), `tests/join.rs`
(real-proof note consolidation), `tests/events.rs` (event wire-format lock), and `tests/base_shield.rs`.
Proof fixtures live in `contracts/settlement/tests/fixtures/ws4/` (regenerate via its `regen.py`, or
`scripts/05`).

### End-to-end demos

- **Local full lifecycle:** `tests/ws4.rs::full_flow_shield_place_place_settle_match` runs shield×2 →
  place×2 → `settle_match` on the local host with real proofs whose witnesses (note/order paths, the
  per-note nonce, nullifier-IMT inserts) are reconstructed by the path server (`tools/indexer`'s
  `witness` bin).
- `scripts/06_book_budget_testnet.sh` — testnet budget run: place_order → settle_match (typical) +
  place_order → cancel_order. `scripts/07_book_worstcase_testnet.sh` — the worst-case `settle_match`
  (1 taker × 3 makers + remainder). Both generate proofs at run time against the live ledger clock
  (WS4 binds `expiry`/`now` to it) and assert each call is within the 400M budget. See `benchmarks.md`.
- `scripts/10_demo_base_shield_testnet.sh` — Base → Stellar shield (see `base-bridge.md`).
- `scripts/{03,04}` (WS1 atomic-`settle` custody demos) await WS4 rework; the live cutover path is
  `scripts/e2e.sh` (see `e2e-testing.md`).

### Web app (frontend + backend)

```bash
./scripts/08_build_web_artifacts.sh         # once / after circuit changes
(cd backend && cargo run)                   # 127.0.0.1:8787
(cd frontend && pnpm install && pnpm dev)   # http://localhost:5173
```

`scripts/08_build_web_artifacts.sh` builds `settlement.wasm` (→ `backend/artifacts/`) and compiles
the lift/unshield/cancel/join/match + wallet helper circuits (→ `frontend/public/circuits/`). The
backend also needs `vks/{lift,unshield,cancel,join,match}_vk` (committed, generated with `bb` v0.87.0;
deploy registers them via `set_vk(op, vk)`). See `backend/README.md` and `frontend/README.md` for
config env vars and endpoints.

### Building the contract for deploy

```bash
cd contracts/settlement && stellar contract build --optimize   # target wasm32v1-none
```

The VK is set once at deploy via the constructor (`--vk_bytes-file-path target/vk`); per-operation
VKs (`set_vk(op, vk)`) register the unshield (op 2) and cancel VKs alongside the order VK (op 1).

## Toolchain & version pinning

The testnet-compatible artifact recipe pins:

| | required |
|--|----------|
| nargo | **1.0.0-beta.9** |
| bb | **v0.87.0** |

`bb` proof format differs across versions, so a mismatch can make valid proofs fail verification. The
committed backend VKs are bb 0.87.0, so browser proofs (`@aztec/bb.js` 0.87.x) verify against them.
Confirmed recipe: `bb prove/write_vk --scheme ultra_honk --oracle_hash keccak --output_format
bytes_and_fields` (`bytes_and_fields` emits the separate `public_inputs` file the contract needs).

soroban-sdk is pinned to **26.0.1** (matched to Nethermind's verifier workspace; the `hazmat-crypto`
feature exposes `poseidon2_permutation` for the on-chain tree). The settlement verifier
(`ultrahonk_soroban_verifier`, a pinned git rev of NethermindEth's public repo) and `soroban-poseidon`
(crates.io `26.0.0`) are now resolved by cargo, so the contract builds **standalone** from a fresh
checkout — no `vendor/` checkout required.

## Web app architecture

Fund actions are durable, high-level operations serialized per wallet/network. The backend records
progress, persists chain events, and controls submission; the browser retains private note selection,
signatures, and ZK proving through leased client actions.

- `frontend/` — Vite + React + TS, Freighter wallet, IndexedDB private notes, in-browser proving
  (`noir_js` + `@aztec/bb.js`).
- `backend/` — Rust (axum): PostgreSQL/SQLite repository, wallet authentication, operation queue,
  durable indexer, membership paths, SSE updates, sponsored relays.

**Desk model.** A *desk* is its own deployed `settlement` contract + a friendbot-funded sponsor
("main") account + its registered assets and pairs. `POST /desks` runs the full deploy pipeline
(mirrors `scripts/06`): generate + fund sponsor → deploy wasm with the lift VK + admin → set
unshield/cancel VKs → register assets (`"native"` → XLM SAC) and pairs.

**Trust / privacy boundary.**
- Plaintext note secrets (`sk`, `rho`) never leave the browser; owner tags, nullifiers, order leaves,
  and proofs are generated in-browser. Freighter `signMessage` deterministically unlocks an
  HKDF-derived recovery key; the backend stores only an opaque AES-GCM snapshot and a write-token
  hash. New note secrets are uploaded before their transaction is submitted.
- The backend is not given the wallet's owned-note inventory; coin selection and split/join planning
  stay client-private.
- Fund-mutation endpoints require a wallet session **plus** the live client-action lease at the head
  of that wallet's FIFO queue; direct relay calls cannot bypass serialization. Progress events are
  persisted and replayed over SSE.
- `place_order` / `settle_match` / `cancel_order` / `unshield` / `join` are relayer-submittable (the
  proof is the spend authority), so the desk sponsor is the sole source/fee payer — fully sponsored.
- `shield` moves the user's own tokens, so it needs the user's authorization but is **also fully
  sponsored** via Soroban auth-entry signing: the frontend builds the tx with the sponsor as source,
  simulates to get the `Address(user)` auth entry, the user signs **only that entry** in Freighter
  (`signAuthEntry`, verified by `authorizeEntry`), and the backend adds the sponsor's envelope
  signature. The signed entry binds the exact invocation, so the sponsor cannot redirect or replay it.

**Proof compatibility.** `bb.js` (`{ keccak: true }`) produces a full UltraHonk proof + public inputs
the on-chain Nethermind verifier accepts against the committed VKs. Verified directly: a
browser-generated lift proof verifies against the deployed VK, and a freshly shielded note proves
in-JS and rests on the on-chain book via the sponsored relay.

## The order-proof circuit (`circuits/lift`)

> **WS4:** the order proof now drives **`place_order`** (rest one order in the order-commitment tree);
> matching is a separate `match` circuit verified by `settle_match`. The proof additionally binds the
> nullifier-IMT transition (`nullifier_root_in`/`out`) and folds a per-note nonce, so the public-input
> vector is now **14 fields** (the contract constants and `circuits/lift/src/main.nr` are the
> authority). The 12-field table below is the WS1 layout, kept for the conceptual walk-through; the
> ownership/membership/nullifier/order-leaf assertions are unchanged in spirit.

The order proof drives `place_order` (and the `cancel`/`match` circuits trust the `order_leaf` it
binds). The contract has no separate `lift` entrypoint; the name is historical. It consumes
one active **asset note** and creates one active **order note**:

```
AssetNote { asset_in, amount_in, owner_tag_in }  --consume-->  OrderNote { asset_in, amount_in,
                                                                asset_out, min_out,
                                                                output_owner_tag, cancel_owner_tag }
```

A proof is needed because the consumed asset note is hidden inside the Merkle set — the contract does
not know *which* note was spent, so it cannot check value conservation in plaintext. (By contrast the
`match` circuit crosses orders whose terms are public in the order tree.)

**v1 decision: full consumption, no change at placement.** `amount_in` equals the consumed note's
amount; no change note is emitted when the order rests. Standard denominations (1/10/100/1000 +
change) are the anonymity lever (`privacy-model.md`), so full consumption is the normal case, and it
removes a conservation subtraction and an output leaf. Partial fills exist only in the matching path:
`settle_match` re-rests the taker's unspent remainder as a fresh order at the taker's exact integer
limit ratio (no separate change note). Change-at-placement is a documented future extension.

### Public input vector (12 fields, BN254, positional)

The contract reads `public_inputs` positionally and the verifier binds the proof to this exact tuple.

| # | name | who uses it | meaning |
|---|---|---|---|
| 0 | `domain` | contract pins to the `lift` constant | domain separator; stops an unshield/cancel proof of the same shape replaying as a lift |
| 1 | `root` | contract: must be in root-history ring | Merkle root the membership proof was made against |
| 2 | `nullifier_in` | contract: must be unused, then record | nullifier of the consumed asset note |
| 3 | `asset_in` | order field; = consumed note asset | offered asset |
| 4 | `amount_in` | order field; = consumed note amount | offered amount (full consumption) |
| 5 | `asset_out` | order field | wanted asset |
| 6 | `min_out` | order field | limit terms, scaled integer (no floats) |
| 7 | `output_owner_tag` | contract stores; `settle` stamps onto proceeds | proceeds destination tag |
| 8 | `cancel_owner_tag` | book stores; `cancel_order` checks proof against it | cancel-authority tag |
| 9 | `expiry` | book rejects if `< ledger timestamp` | order validity deadline (unix seconds) |
| 10 | `partial_allowed` | book honors when matching; circuit constrains to {0,1} | may this order be partially filled |
| 11 | `order_leaf` | book stores as the order's identity; `cancel` references it | `H8(asset_in, amount_in, asset_out, min_out, output_owner_tag, cancel_owner_tag, expiry, partial_allowed)` |

`place_order` reads all fields; `settle_match`/`cancel` trust the `order_leaf` (and re-derive the
order-consumption nullifier `compress(7, order_leaf)`). `order_leaf` and `nullifier_in` are exposed
(not recomputed on-chain) so the contract doesn't pay Poseidon cost; it trusts the in-circuit
assertion that each equals the hash of the stored public fields.

### Private witness

| name | meaning |
|---|---|
| `rho_in` | per-note randomness of the consumed asset note |
| `sk_o` | owner secret; `pk_o = H(sk_o)`, `owner_tag = H(pk_o, rho_in)` |
| `path[DEPTH]` | Merkle sibling path for the consumed note |
| `index_bits[DEPTH]` | path direction bits (each constrained boolean) |

`output_owner_tag` and `cancel_owner_tag` are user-chosen public inputs bound into `order_leaf` but
**not** re-derived from `sk_o` — a user may direct proceeds to any tag. Binding-into-the-leaf is what
stops a relayer or the contract redirecting them.

### In-circuit assertions

1. `pk_o = H(sk_o)`
2. `owner_tag_in = H(pk_o, rho_in)`
3. `input_leaf = H(asset_in, amount_in, owner_tag_in)`
4. membership: fold `input_leaf` up `path`/`index_bits`; assert result `== root`
5. nullifier: assert `H(sk_o, rho_in) == nullifier_in`
6. order leaf: assert `H8(...) == order_leaf`
7. domain: assert `domain == LIFT_DOMAIN` (a circuit constant)
8. flag: assert `partial_allowed * (partial_allowed - 1) == 0` (boolean)

Hashing convention: a 2-to-1 `compress` built from `poseidon2_permutation` (width 4, first lane),
folded left-to-right for multi-input hashes. The contract and wallet **must** use the identical fold
order or leaves/nullifiers won't match.

### Contract obligations (the other half of soundness)

A proof is necessary but not sufficient. On a verifying order proof the contract MUST: pin
`public_inputs[0] == LIFT_DOMAIN`; check `root` is in the root-history ring (reject stale); check
`nullifier_in` is unused, then record it **before** any output becomes active (single-use); construct
all outputs itself from checked public values — **never** accept a caller-supplied output commitment.

Related circuits: `circuits/unshield` (recipient-bound asset-note spend, domain 2), `circuits/cancel`
(domain 3; proves order-tree membership of `order_leaf` + knowledge of `cancel_owner_tag`, inserts the
order-consumption nullifier into the IMT, binds `return_owner_tag`), `circuits/join` (domain 4;
consolidate two same-asset notes), and `circuits/match` (domain 5; settle 1 taker × ≤3 makers, the
`settle_match` proof). Every spend circuit now folds a per-note nonce and proves its nullifier-IMT
insert in-circuit.

## Storage durability

The contract custodies real funds, so the accounting that governs them (the nullifier-IMT root, the
note + order trees, root history, pairs, VKs) must never disappear. Soroban has three storage tiers:

| tier | on TTL expiry | used here for |
|---|---|---|
| **temporary** | permanently deleted, unrecoverable | nothing (banned for fund-critical data) |
| **persistent** | archived, not deleted — restorable via `RestoreFootprint` (pay rent) | all protocol state |
| **instance** | archives with the contract instance; restorable | admin |

The contract uses **only persistent and instance** (verified: zero `temporary()` calls). Two protocol
properties make this safe: (1) archived ≠ deleted — an archived persistent entry is kept in the
archive forever and anyone can restore it; (2) no silent miss — you cannot transact against an
archived persistent entry as if it were absent (access fails until restored), so a spent nullifier can
never read back as "unspent." Worst realistic failure is **temporary inaccessibility until someone
pays to restore** — never loss, never double-spend — and restoration is **permissionless**.

**WS4 closed the only unbounded rent surface.** The per-spend nullifier *set* is gone: the nullifier
accumulator is a **single `NullifierRoot` (U256)**, with non-membership + insert proven in-circuit and
just a root CAS on-chain (`advance_nullifier_root`). So nullifier state is now **O(1)** and bumped by
`bump_core` like the trees — the only remaining unbounded persistent state is the note/order **root
histories**.

Mechanism (persistent TTLs decay and can't be extended forever):
- **Bumps on write.** Every fund-critical write extends the entry's TTL to `max_ttl()`. The hot state
  (instance, the per-tree filled/next/root frontier singletons, and the single `NullifierRoot`) is
  refreshed by `bump_core` at the end of every state-changing call; pairs, assets, VKs are bumped where
  written. Cheap — a flat cost, ~0.04% of `settle_match`'s worst case (not a rewrite).
- **`keep_alive()`** — permissionless heartbeat re-extending all **bounded** structural state to max.
- **`keep_alive_keys(note_roots, order_roots)`** — permissionless targeted heartbeat for the
  **unbounded** root histories; a keeper or a user about to prove against an old root refreshes exactly
  what they need.

Operational: run a keeper calling `keep_alive()` on an interval shorter than `max_ttl` and bumping the
instance + Wasm code entries; for the root histories, sweep recent entries via `keep_alive_keys` or
rely on permissionless restore at proof time.

## Status: what's done and what's left

WS4 (Noir matching + tree-backed orders/nullifiers) is functionally complete: circuits, the merged
contract, the off-chain services, and in-browser proving (incl. the taker auto-match path) all built;
**43 local tests** pass (real UltraHonk proofs on the Soroban host).

**Done (production-blocking safety/correctness):** storage durability (above; the unbounded
nullifier-set rent surface is now **closed** — O(1) accumulator root); the worst-case `settle_match`
(1 taker × 3 makers + remainder) measured on testnet at **260.7M instructions (~65% of 400M)** and
accepted — see `benchmarks.md`. All five entrypoints (`place_order`, `settle_match`, `cancel_order`,
`unshield`, `join`) verify within budget.

**Open — robustness:**
- **Bounded root history** → ring eviction (nullifier accumulator prevents double-spend regardless).
- **Maker-discovery without an indexer.** A resting maker recovers its (foreign-taker) proceeds via
  the backend's event-correlation endpoint; a fully-direct/verifiable scheme is future work.
- **MEV / ordering.** `settle_match` is permissionless; a valid-but-not-best match can land first
  (documented in `noir-matching.md`). Needs a threat-model pass; WS5 territory.

**Open — productionization:**
- **Admin surface:** upgradeability + pause; pair relisting/delisting (pairs are currently permanent).
- **Lot-granularity / tick-size policy** (coprime-priced orders can't partially fill cleanly).
- **Wrapped assets:** define issuers/bridges before advertising ETH/XRP support.
- **Testnet hard-cutover** via `scripts/e2e.sh` (fresh deploy; live place/match/cancel); rework the
  WS1-era `scripts/{03,04}` custody demos.

None of the open gaps can lose funds. Not hardened: no keeper running (TTL upkeep manual; data safe
regardless), demo scripts use literal owner tags and map both asset-ids to the native XLM SAC.
