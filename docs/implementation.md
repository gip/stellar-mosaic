# Implementation: how it's built, how to run it

The concrete implementation reference: how to build and run the stack, the order-proof circuit spec,
storage durability, and the status of what's left. Design rationale is in `architecture.md`;
measurements are in `benchmarks.md`.

## Getting started

### Local prove + contract tests (no testnet)

```bash
./scripts/01_build_prove.sh                      # local prove/verify half
cd contracts/settlement && cargo test --test integration   # full custody loop on the local Soroban host
```

The integration test exercises shield (token custody) → atomic `settle` (verify two crossing order
proofs in one tx) → `unshield` (recipient-bound asset-note spend), plus negatives (unpublished root,
replayed settle, tampered order field, incompatible orders, wrong unshield recipient). Proof fixtures
live in `contracts/settlement/tests/fixtures/` (regenerate via `regen.sh`). `cargo test -p settlement`
runs the full suite (34 local tests: real UltraHonk + cancel proofs on the Soroban host).

### End-to-end demos

- `scripts/03_demo_e2e.sh` + `contracts/settlement/tests/e2e_demo.rs` — full lifecycle on the local
  host with real proofs whose membership witnesses are reconstructed by the path server: A shields
  asset 1, trades into asset 2 via atomic `settle`, then unshields **the proceeds note `settle`
  created** (a note that exists only as a tree leaf, whose Merkle path the indexer rebuilds from event
  history). Run the script, then `cargo test -p settlement`.
- `scripts/04_demo_e2e_testnet.sh` — the authoritative testnet version: deploys the contract and
  submits the same flow as real transactions, reusing the local-host proofs unchanged (they bind the
  protocol asset-id and the Merkle root, not token addresses, and the on-chain tree is deterministic).
  Both protocol asset-ids map to the native XLM SAC for a robust run.
- `scripts/06_book_budget_testnet.sh` — order-book lifecycle (shield → rest → cross/partial-fill →
  cancel); `scripts/07_book_worstcase_testnet.sh` — worst-case stress.
- `scripts/10_demo_base_shield_testnet.sh` — Base → Stellar shield (see `base-bridge.md`).

### Web app (frontend + backend)

```bash
./scripts/08_build_web_artifacts.sh         # once / after circuit changes
(cd backend && cargo run)                   # 127.0.0.1:8787
(cd frontend && pnpm install && pnpm dev)   # http://localhost:5173
```

`scripts/08_build_web_artifacts.sh` builds `settlement.wasm` (→ `backend/artifacts/`) and compiles
the lift + wallet helper circuits (→ `frontend/public/circuits/`). The backend also needs
`vks/{lift,unshield,cancel}_vk` (committed, generated with `bb` v0.87.0). See `backend/README.md` and
`frontend/README.md` for config env vars and endpoints.

### Building the contract for deploy

```bash
cd contracts/settlement && stellar contract build --optimize   # target wasm32v1-none
```

The constructor validates and installs the order, unshield, cancel, and join VKs **and** the full
asset/pair set atomically:

```
__constructor(lift_vk, unshield_vk, cancel_vk, join_vk, admin,
              assets: Vec<AssetInit>, pairs: Vec<PairDef>)
```

`AssetInit { asset_id, token: Option<Address>, kind }` declares each supported asset (token `Some`
for `Stellar`/`Dual`, `None` for `BaseRepresented`); `PairDef { base_asset, quote_asset }` declares
the canonical markets (pair ids assigned 0,1,… in order). There is **no** post-deployment mutation
entrypoint for VKs, assets, or pairs — all are immutable from creation. Read-only views:
`protocol_config()` (pinned VK hashes), `asset(asset_id) -> Option<AssetDef>`, `pair_count()`. The
backend passes `assets`/`pairs` as JSON to `stellar contract deploy` (see `backend/src/deploy.rs`).

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
feature exposes `poseidon2_permutation` for the on-chain tree). The contract depends on a **vendored**
Nethermind verifier path under `vendor/` (gitignored), so it does not build standalone — making it
reproducible is an open item.

## Web app architecture

Fund actions are durable, high-level operations serialized per wallet/network. The backend records
progress, persists chain events, and controls submission; the browser retains private note selection,
signatures, and ZK proving through leased client actions.

- `frontend/` — Vite + React + TS, Freighter wallet, IndexedDB private notes, in-browser proving
  (`noir_js` + `@aztec/bb.js`).
- `backend/` — Rust (axum): PostgreSQL/SQLite repository, wallet authentication, operation queue,
  durable indexer, membership paths, SSE updates, sponsored relays.

**Desk model.** A *desk* is its own deployed `settlement` contract + a friendbot-funded sponsor
("main") account + its (immutable) assets and pairs. `POST /desks` runs the deploy pipeline:
generate + fund sponsor → deploy wasm with all immutable VKs + admin + the asset set (each with its
`AssetKind`; `"native"` → XLM SAC, a `BaseRepresented` asset has no Stellar token) + the canonical
pairs, all as constructor args. There is no longer a post-deploy `register_asset`/`register_pair`
step — a desk is fully configured by its constructor.

**Dual-wallet and Base deployment.** Freighter on Stellar Testnet remains the login identity;
MetaMask is an optional Base Sepolia transaction wallet and cannot connect in the app until Stellar
is connected. A desk creator can opt into a browser-paid `MosaicBridge` deployment. The bridge
constructor registers every selected Base asset atomically — ERC-20s by address, native ETH under the
`NATIVE` sentinel (deposited via the payable `shieldNative`) — then the backend verifies the receipt,
canonical runtime bytecode, owner, and catalog mappings before its sponsor calls
`configure_base_bridge`. A rejected or failed MetaMask transaction never rolls back the valid
Stellar desk, and successful deployment transaction details are retained for configuration retries.

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
- `submit_order` / `unshield` / `cancel_order` are relayer-submittable (the proof is the spend
  authority), so the desk sponsor is the sole source/fee payer — fully sponsored.
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

The order proof, consumed directly by atomic `settle`/`settle_exact` and by the on-chain order book
(`submit_order`). The contract has no separate `lift` entrypoint; the name is historical. It consumes
one active **asset note** and creates one active **order note**:

```
AssetNote { asset_in, amount_in, owner_tag_in }  --consume-->  OrderNote { asset_in, amount_in,
                                                                asset_out, min_out,
                                                                output_owner_tag, cancel_owner_tag }
```

A proof is needed because the consumed asset note is hidden inside the Merkle set — the contract does
not know *which* note was spent, so it cannot check value conservation in plaintext. (By contrast
`settle` crosses two already-active, public order notes in the clear.)

**v1 decision: full consumption, no change at lift.** `amount_in` equals the consumed note's amount;
no change note is emitted at lift. Standard denominations (1/10/100/1000 + change) are the anonymity
lever (`privacy-model.md`), so full consumption is the normal case, and it removes a conservation
subtraction and an output leaf. Change still happens at **settle** for partial fills (plaintext,
proof-free). Change-at-lift is a documented future extension (add a `change_leaf` public input +
`amount_in + change_amount == note_amount`).

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

`settle`/`settle_exact` use fields `[0..8]`; the order book additionally reads `cancel_owner_tag`,
`expiry`, `partial_allowed`, `order_leaf`. `order_leaf` and `nullifier_in` are exposed (not recomputed
on-chain) so the contract doesn't pay Poseidon cost; it trusts the in-circuit assertion that each
equals the hash of the stored public fields.

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
(domain 3; proves knowledge of `cancel_owner_tag`, binds `order_leaf` + `return_owner_tag`, no
membership proof since the resting order is plaintext on-chain).

## Storage durability

The contract custodies real funds, so the accounting that governs them (nullifiers, the note tree,
roots, the order book, pairs, VKs) must never disappear. Soroban has three storage tiers:

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

Mechanism (persistent TTLs decay and can't be extended forever):
- **Bumps on write.** Every fund-critical write extends the entry's TTL to `STORAGE_TTL_LEDGERS`
  (120,960 ledgers, about one week at a 5s ledger cadence), capped by the network max. The hot state
  (instance, the tree singletons `TreeFilled`/`TreeNext`/`TreeRoot`, the current root marker) is
  refreshed by `bump_core` at the end of every state-changing call; nullifiers, books, pairs, assets,
  VKs are bumped where written. Cheap — ~0.04% of `submit_order`'s worst case (a flat cost, not a
  rewrite).
- **`keep_alive()`** — permissionless heartbeat re-extending all **bounded** structural state to the
  one-week target.
- **`keep_alive_keys(nullifiers, roots)`** — permissionless targeted heartbeat for the **unbounded**
  sets; a keeper or a user about to spend an old note refreshes exactly what they need.

Operational: run a keeper calling `keep_alive()` on an interval shorter than the one-week target and
bumping the instance + Wasm code entries; for the unbounded sets, sweep recent entries via
`keep_alive_keys` or rely on permissionless restore at spend time. Test:
`contracts/settlement/tests/book.rs::critical_state_ttl_is_extended_and_kept_alive`.

## Status: what's done and what's left

Functionally complete and demonstrable end-to-end on testnet (un-hardened). 34 local tests (real
UltraHonk + cancel proofs on the Soroban host).

**Done (production-blocking safety/correctness):** storage durability (above); worst case fits all
per-tx resource limits (359.8M instructions ~89%, 25,776 write bytes ~20%, 0 disk-read; see
`benchmarks.md`).

**Open — robustness:**
- **Crossed-book crank (`match_book`).** A partial-allowed taker that sweeps deeper than
  `MAX_FILLS_PER_SUBMIT` rests its remainder over still-crossing makers, leaving a price-crossed book
  until the next taker. Add a permissionless crank that crosses top-of-book resting orders (reusing
  `compute_lots`, no new proof). Not fund-safety.
- **Unbounded root history** → bounded-ring eviction (nullifiers prevent double-spend regardless).
- **Book storage: keyed entries + sorted index** instead of a per-op re-(de)serialized
  `Vec<OrderEntry>`; do only if measured write-bytes/CPU headroom demands it.
- **Test gaps:** FOK taker revert (`NotPartialAllowed`) with a real proof; `prune_expired` on testnet.
- **Richer events + stable order ids** (`placed`/`filled`/`cancelled`/`pruned`); only `noteins` today.

**Open — productionization:**
- **Admin surface:** upgradeability + pause; pair relisting/delisting (pairs are currently permanent).
- **Nullifier accumulator:** replace the per-spend nullifier set (the only unbounded rent surface)
  with a single accumulator root, proving non-membership in-circuit — bounds live state to O(1).
- **Lot-granularity / tick-size policy** (coprime-priced orders can't partially fill).
- **Relayer / MEV ordering:** `submit_order` ordering is relayer-controlled; needs a threat-model pass.
- **Standalone build:** the vendored Nethermind verifier path is gitignored; make it reproducible.
- **Wrapped assets:** define issuers/bridges before advertising ETH/XRP support.

None of the open gaps can lose funds. Not hardened: no keeper running (TTL upkeep manual; data safe
regardless), demo scripts use literal owner tags and map both asset-ids to the native XLM SAC.
