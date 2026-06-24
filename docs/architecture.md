# Architecture

The entry-point design document for Stellar Mosaic — a privacy-preserving DEX on Stellar/Soroban.
Companion docs: `privacy-model.md` (the privacy model), `note-types.md` (note structures),
`noir-matching.md` (**WS4: the current matching model — matching in Noir + tree-backed
orders/nullifiers**), `simple-order-book.md` (the WS1 on-chain `Vec` book, now superseded),
`base-bridge.md` (Base → Stellar shield), `implementation.md` (how it's built and run, the order-proof
circuit spec, storage), and `benchmarks.md` (all cost measurements and the verifier-choice provenance).

## The verdict

The v1 design is **owner-anonymous and amount-transparent**:

- **Public:** note asset/amount, order pair/price/size, matches, fill amounts, and timing.
- **Hidden:** the owner behind each note/order, the create-to-spend link, and which note a spend
  consumed.
- Matching runs in a **Noir circuit** and settles in one **permissionless** transaction that verifies
  a single match proof (1 taker × ≤3 makers); the contract mints only the proceeds the verified proof
  binds.
- UltraHonk is used for the order/unshield/cancel/join/match proofs — no per-circuit trusted setup.

The privacy claim is "no direct owner/wallet linkage inside the pool," not amount privacy. Amounts and
timing remain followable; standard denominations and delayed unshields are mitigations, not complete
fixes (`privacy-model.md`).

## Budget and the settlement shape

The per-transaction CPU limit is **400,000,000 instructions** (testnet and mainnet). One UltraHonk
verify is ~80M (~20%). WS4 moved **matching into a Noir `match` circuit**, so a whole trade — taker
crossed against up to 3 makers — settles with **one verify** plus the tree inserts:

```
TX: place_order    verify order proof, advance the nullifier accumulator, append the order leaf
TX: settle_match   verify ONE match proof (1 taker × ≤3 makers + remainder), advance the
                   accumulator past every consumed order, mint the bound proceeds, re-rest the remainder
```

Measured on testnet: `place_order` ~30%, a 1×1 `settle_match` ~40%, the worst case (1 taker × 3
makers + remainder) **~65% of 400M with ~35% headroom** — matching is one verify regardless of fills,
since the makers are bound in the proof rather than loaded on-chain. This replaced WS1's atomic
two-verify `settle` and the verify-at-lift / settle-cheap 3-tx design (which existed only because we
wrongly believed the limit was ~100M). The full budget story and every measurement are in
`benchmarks.md`.

The **order book is lit and off-chain-matched**: a party rests an order proof (`circuits/lift` →
`place_order`) into the on-chain order-commitment tree, and the book is **reconstructed from events**
(no on-chain `Vec`). Anyone can act as taker: build a `match` proof crossing a resting taker order
against resting makers and submit `settle_match`. Order data (pair/price/size) is public anyway, so
the lit book preserves the "lit pool" property while settlement stays on-chain and atomic (the
Renegade-style off-chain-book / on-chain-settlement shape). Match submission is **permissionless**; a
valid-but-not-best match can land first — a documented ordering/MEV limitation (`noir-matching.md`).
The WS1 on-chain `Vec` book (`simple-order-book.md`) is superseded.

## Contract and state

One merged contract, `contracts/settlement`, owns custody, the nullifier accumulator, the note + order
trees, matching, and settlement (a split Assets/Desk design would add a cross-contract call and is not
needed). Roles:

- **Custody:** holds real Soroban tokens (`shield`/`unshield`), keyed by an admin-registered
  asset-id → token map; maintains the on-chain note tree and the nullifier accumulator.
- **Nullifier accumulator:** an indexed-merkle-tree (IMT) whose **single root** lives on-chain. Each
  spend proves non-membership + insert in-circuit; the contract only CAS-advances the root
  (`advance_nullifier_root`) — O(1) state, no per-spend Poseidon, no unbounded set.
- **Desk:** order placement (`place_order`) into the order-commitment tree, permissionless matching
  (`settle_match`), and `cancel_order` (proven order-tree membership + cancel authority + refund).

Supported assets are admin-gated. USDC and XLM can be native Stellar/Soroban assets; ETH and XRP
require wrapped issuers or bridge integrations (the Base bridge shields Base-USDC; see
`base-bridge.md`).

**Trading pairs** are admin-registered in a canonical orientation via `register_pair(base, quote)`
(e.g. `XLM/USDC`, never `USDC/XLM`). The orientation is fixed by the pair definition, so an order's
side is well-defined regardless of how the user phrased its assets: SELL = give base / want quote, BUY
= give quote / want base. Registering the reverse orientation of an existing pair is rejected (same
market). Pair ids are assigned sequentially from 0.

## The commitment trees (on-chain)

The contract maintains two depth-32 append-only trees itself — a **note tree**
(`shield`/`settle_match` proceeds/`join` outputs/`cancel` returns insert leaves) and an **order tree**
(`place_order` and a re-rested match remainder append order leaves). Each tree's root advances and is
accepted automatically, no admin publisher. A third structure, the **nullifier IMT**, is not stored
leaf-by-leaf on-chain — only its root is; spenders prove the insert in-circuit. The on-chain
`compress` is **byte-identical to the circuits**: host `poseidon2_permutation` with the
`stellar/rs-soroban-poseidon` BN254 t=4 constants, unit-tested against Noir (`compress(1,2)`,
`compress(0,0)`, and the full zeros ladder all match).

`tools/indexer` (crate `mosaic-indexer`) is a read-only off-chain path server. It rebuilds note-tree
membership paths from `shielded`/`noteins` events, order-tree paths from `orderins`, and the nullifier
IMT (with low-leaf witnesses for the next spender) from `nfspent` — the trees store only filled
subtrees on-chain, not all leaves. It is **not a trust anchor** — the on-chain roots are. It reuses
the contract's exact `compress` (via a local Soroban `Env` as a hash engine), so its roots are
byte-identical by construction. The tests cross-check that the indexer's reconstructed roots equal the
on-chain `root()`/`order_root()`/`nullifier_root()` *and* the roots the committed proofs were made
against, and that every indexer-derived path folds back. The active **book is event-derived**: a
resting order = an `orderins` leaf whose consumption nullifier `compress(7, order_leaf)` is not yet in
`nfspent`, scanned over the `MAX_ORDER_TTL` (7-day) window.

## Flow

1. **Shield** — user transfers a supported asset into custody; the contract mints an
   `AssetNote { asset, amount, owner_tag }` by inserting `Poseidon(asset, amount, owner_tag)` into the
   tree and emits a `shielded` event so off-chain clients can rebuild paths. Proof-free: the token
   transfer enforces the amount and amounts are public.

2. **Place order** (proof = `circuits/lift` → `place_order`) — a party proves membership of an asset
   note, binds the order terms (`asset_in`, `amount_in`, `asset_out`, `min_out`, `output_owner_tag`,
   `cancel_owner_tag`, `expiry`, `partial_allowed`) into an `order_leaf`, and proves the consumed
   note's nullifier-IMT insert in-circuit. The contract CAS-advances the accumulator and appends the
   `order_leaf` to the order tree (enforcing `now ≤ expiry ≤ now + MAX_ORDER_TTL`). A resting order is
   reclaimed with `cancel_order` (a cancel proof) or simply expires.

3. **Settle match** (one verify; permissionless; proof = `circuits/match` → `settle_match`) — any
   party crosses one taker order against ≤3 makers on the same pair. The proof binds the order-tree
   `order_root` the matched orders are members of, the nullifier-accumulator transition that consumes
   them (taker + makers, via the public order-consumption nullifiers `compress(7, order_leaf)`), the
   crossing/conservation checks, every proceeds leaf, and any re-rested remainder (the taker's leftover
   at its exact integer limit ratio). The contract checks roots/time, CAS-advances the accumulator,
   and **mints only the bound proceeds + re-rests the bound remainder** — never a caller-supplied
   output. A **per-note nonce** `compress(taker_leaf, slot)` is folded into every minted note so an
   order can fill incrementally without nullifier collisions.

4. **Unshield** (proof = `circuits/unshield`) — user spends an asset note with a proof that binds the
   payout **recipient** (public input `[7] == sha256(to.to_xdr())`, top byte zeroed) and the
   nullifier-IMT insert, so a relayer can submit but cannot redirect. The contract advances the
   accumulator, then transfers the public `asset`/`amount` to `to`. (`circuits/join` similarly
   consolidates two same-asset notes inside the pool.)

Per-operation VKs: the order/lift VK (op 1) is set at construction; `set_vk(op, vk)` registers
unshield (op 2), cancel (op 3), join (op 4), and match (op 5).

## End-to-end demo

`contracts/settlement/tests/ws4.rs::full_flow_shield_place_place_settle_match` runs the full lifecycle
on the local host with real proofs whose witnesses (note/order paths, the per-note nonce,
nullifier-IMT inserts) are reconstructed by the path server: shield two notes, `place_order` both,
then `settle_match` crosses them and mints both proceeds — notes that exist only as tree leaves, whose
Merkle paths the indexer rebuilds from event history (impossible without the path server). The testnet
budget runs are `scripts/06` (place/match/cancel) and `scripts/07` (worst-case match); both generate
proofs at run time against the live ledger clock. Step-by-step run instructions and measured costs:
`implementation.md` and `benchmarks.md`.

## Soundness invariants

- **Full binding in the order proof:** each order proof binds its consumed nullifier (and the IMT
  transition that consumes it), `asset_in`, `amount_in`, `asset_out`, `min_out`, `output_owner_tag`,
  `cancel_owner_tag`, `expiry`, `partial_allowed`, the membership `root`, and a domain separator.
- **Match trusts only verified public inputs:** `settle_match` builds nothing from the caller — the
  proof binds the `order_root`, the full accumulator transition, the crossing/conservation checks,
  every proceeds leaf, and the remainder. The contract checks roots/time and inserts the bound leaves.
- **Distinct, unspent orders:** every order a match consumes has a distinct order-consumption
  nullifier, all unused, inserted (via the accumulator CAS) before any proceeds are minted (single-use).
- **Settlement constructs outputs:** proceeds are built from the bound `output_owner_tag` + per-note
  nonce and the matched amounts; the contract never accepts caller-supplied output commitments.
- **One accumulator, closed rent:** one merged contract holds the single nullifier-IMT root (no split
  registries → no double-spend risk; O(1) state, no unbounded set).
- **Accepted roots only:** proofs must be made against a note/order root in the on-chain history, and
  the match's `nullifier_root_in` must equal the current accumulator (a stale match reverts cheaply).
- **Durable state:** all fund-critical state is persistent/instance storage (never temporary), TTL
  bumped to max on write, with permissionless `keep_alive` heartbeats. See `implementation.md`.

## Status

WS4 (Noir matching + tree-backed orders/nullifiers) is functionally complete and demonstrable
end-to-end: circuits, the merged contract, off-chain services, and in-browser proving (incl. the taker
auto-match path) all built; 43 local tests pass. The production-blocking safety items are done —
storage durability with the **unbounded nullifier-set rent surface now closed** (O(1) accumulator
root), and the worst-case `settle_match` (1 taker × 3 makers + remainder) measured on testnet at
~65% of the 400M budget and accepted. The Base → Stellar shield is validated live. Remaining work is
operational/productionization: the testnet hard-cutover deploy, an admin/pause surface, lot-granularity
policy, and an MEV/ordering threat-model pass for permissionless matching. **None of the open gaps can
lose funds.** The full list with rationale is in `implementation.md`; the matching design is in
`noir-matching.md`.
