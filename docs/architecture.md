# Architecture

The entry-point design document for Stellar Mosaic — a privacy-preserving DEX on Stellar/Soroban.
Companion docs: `privacy-model.md` (the privacy model), `note-types.md` (note structures),
`simple-order-book.md` (the on-chain book), `base-bridge.md` (Base → Stellar shield),
`implementation.md` (how it's built and run, the order-proof circuit spec, storage), and
`benchmarks.md` (all cost measurements and the verifier-choice provenance).

## The verdict

The v1 design is **owner-anonymous and amount-transparent**:

- **Public:** note asset/amount, order pair/price/size, matches, fill amounts, and timing.
- **Hidden:** the owner behind each note/order, the create-to-spend link, and which note a spend
  consumed.
- A trade settles **atomically in one transaction** that verifies both sides' order proofs.
- UltraHonk is used for order/unshield proofs — no per-circuit trusted setup.

The privacy claim is "no direct owner/wallet linkage inside the pool," not amount privacy. Amounts and
timing remain followable; standard denominations and delayed unshields are mitigations, not complete
fixes (`privacy-model.md`).

## Budget and the settlement shape

The per-transaction CPU limit is **400,000,000 instructions** (testnet and mainnet). One UltraHonk
verify is ~80M (~20%), so **two verifies in one tx (~160M, ~40%) fit comfortably**. A two-sided trade
is therefore a single atomic transaction:

```
TX: settle    verify order proof A + verify order proof B, check they cross,
              record both nullifiers, mint proceeds notes
```

This replaced an earlier verify-at-lift / settle-cheap design (a 3-tx maker-lift / taker-lift / settle
dance), which existed only because we wrongly believed the limit was ~100M. With the real 400M budget
the split is unnecessary. The full budget story and every measurement are in `benchmarks.md`.

The **order book is lit and off-chain-matched**: a party generates an order proof (`circuits/lift`)
and hands it to a matcher; the matcher pairs two crossing proofs and submits `settle`. Order data
(pair/price/size) is public anyway, so a lit book preserves the "lit pool" property while settlement
stays on-chain and atomic (the Renegade-style off-chain-book / on-chain-settlement shape). Orders can
also be **rested on-chain** in the contract's order book (`simple-order-book.md`).

## Contract and state

One merged contract, `contracts/settlement`, owns custody, the nullifier registry, the note tree,
matching, settlement, and the order book (a split Assets/Desk design would add a cross-contract call
and is not needed). Roles:

- **Custody:** holds real Soroban tokens (`shield`/`unshield`), keyed by a constructor-fixed
  asset-id → `AssetDef` map; maintains the canonical nullifier registry and the on-chain note tree.
- **Desk:** atomic matching/settlement (`settle`/`settle_exact`) and the resting order book.

### Asset classes (configured statically at creation)

Every supported asset is declared once, in the constructor, with an immutable `AssetKind` that fixes
which deposit routes it may legally use. There is **no post-deploy `register_asset`/`register_pair`**
— a desk's asset/pair set is baked in at deploy (mirroring how `MosaicBridge.sol` registers its
assets in its constructor), so a desk can never be half-configured or silently rebound.

| Class | Example | Stellar side | `shield` | `shield_from_base` | `unshield` |
|-------|---------|--------------|:--------:|:------------------:|:----------:|
| `Stellar`         | XLM  | distributed (real SAC)        | ✅ | ❌ | ✅ |
| `Dual`            | USDC | distributed (real SAC)        | ✅ | ✅ | ✅ |
| `BaseRepresented` | ETH  | represented only (note-space) | ❌ | ✅ | ❌ (trade-only) |

`AssetDef { token: Option<Address>, kind }` carries the real Soroban token for `Stellar`/`Dual`
(transferred by `shield`/`unshield`) and `None` for `BaseRepresented` (which only ever exists as a
tree note and is moved by trading, never by a Stellar transfer). The deposit-path checks live in
`shield` (rejects `BaseRepresented` → `AssetNotShieldable`), `shield_from_base` (rejects `Stellar` →
`AssetNotBridgeable`), and `unshield` (rejects `BaseRepresented` → `AssetNotUnshieldable`). On Base,
a native-ETH asset is deposited via `MosaicBridge.shieldNative` (the `NATIVE` sentinel); ERC-20s use
`shield`. See `base-bridge.md`.

**Trading pairs** are constructor-registered in a canonical orientation (`PairDef { base, quote }`,
e.g. `XLM/USDC`, never `USDC/XLM`). The orientation is fixed by the pair definition, so an order's
side is well-defined regardless of how the user phrased its assets: SELL = give base / want quote, BUY
= give quote / want base. Registering the reverse orientation of an existing pair is rejected (same
market). Pair ids are assigned sequentially from 0 in declaration order.

## The note commitment tree (on-chain)

The contract maintains the depth-32 append-only note tree itself — `shield`/`settle`/book fills insert
leaves, the root advances and is accepted automatically, no admin publisher. The on-chain `compress`
is **byte-identical to the circuits**: host `poseidon2_permutation` with the
`stellar/rs-soroban-poseidon` BN254 t=4 constants, unit-tested against Noir (`compress(1,2)`,
`compress(0,0)`, and the full zeros ladder all match).

`tools/indexer` (crate `mosaic-indexer`) is a read-only off-chain path server that rebuilds membership
paths from `shielded`/`settled`/`noteins` events (the tree stores only filled subtrees on-chain, not
all leaves). It is **not a trust anchor** — the on-chain root is. It reuses the contract's exact
`compress` (via a local Soroban `Env` as a hash engine), so its roots are byte-identical by
construction. The integration test cross-checks that the indexer's reconstructed root equals the
on-chain `root()` *and* the root the committed proofs were generated against, and that every
indexer-derived path folds back to that root.

## Flow

1. **Shield** — from Stellar, the user transfers a supported asset into custody; the contract mints an
   `AssetNote { asset, amount, owner_tag }` by inserting `Poseidon(asset, amount, owner_tag)` into the
   tree and emits a `shielded` event so off-chain clients can rebuild paths. Proof-free: the token
   transfer enforces the amount and amounts are public. A configured desk can instead accept a
   Base Sepolia deposit through `shield_from_base`; both sources create the same Stellar note type.

2. **Order** (off-chain; proof = `circuits/lift`) — a party proves membership of an asset note,
   reveals its nullifier, and binds the order terms (`asset_in`, `amount_in`, `asset_out`, `min_out`,
   `output_owner_tag`, plus `cancel_owner_tag`/`expiry`/`partial_allowed` for the book). The proof is
   handed to a matcher (atomic `settle`/`settle_exact`) OR rested on-chain via `submit_order`. A
   purely off-chain order is "cancelled" by spending its note another way (e.g. `unshield`); a resting
   order is cancelled with a cancel proof or pruned on expiry.

3. **Settle** (atomic, two verifies) — a matcher submits two crossing order proofs. The contract
   verifies BOTH, derives each order from its verified public inputs, checks asset + price
   compatibility in plaintext, requires the two notes distinct and unspent, records both nullifiers,
   and mints proceeds as new asset notes stamped with each order's bound `output_owner_tag` (no
   caller-supplied output commitments). `settle_exact` is the strict-equality sibling (exact reverses
   on a registered canonical pair — no surplus, no partial); it is the primitive the order book
   settles against. The general crossing check is `orders_cross` (an exact-integer `U256`
   cross-multiplication), which the book uses for partial fills.

4. **Unshield** (proof = `circuits/unshield`) — user spends an asset note with a proof that binds the
   payout **recipient** (public input `[5] == sha256(to.to_xdr())`, top byte zeroed), so a relayer can
   submit but cannot redirect. The contract records the nullifier, then transfers the public
   `asset`/`amount` to `to`.

All operation VKs (order, unshield, cancel, and join) are validated and installed atomically by the
constructor. They are immutable after deployment; `protocol_config()` exposes their hashes.

## End-to-end demo

`scripts/03_demo_e2e.sh` + `contracts/settlement/tests/e2e_demo.rs` run the full lifecycle on the
local host with real proofs whose membership witnesses are reconstructed by the path server: A shields
asset 1, trades into asset 2 via atomic `settle`, then **unshields the proceeds note `settle` created**
— a note that exists only as a tree leaf, whose Merkle path the indexer rebuilds from event history
(impossible without the path server). `scripts/04_demo_e2e_testnet.sh` is the authoritative testnet
version. Step-by-step run instructions and measured costs: `implementation.md` and `benchmarks.md`.

## Soundness invariants

- **Full binding in the order proof:** each order proof binds its consumed nullifier, `asset_in`,
  `amount_in`, `asset_out`, `min_out`, `output_owner_tag`, the membership `root`, and a domain
  separator. `settle` trusts nothing the caller passes outside the verified public inputs.
- **Both sides verified:** `settle` verifies both proofs before any state change.
- **Distinct, unspent notes:** the two sides must have different nullifiers, both unused, recorded
  before any proceeds are minted (single-use).
- **Settlement constructs outputs:** proceeds are built from the bound `output_owner_tag` and the
  matched fill amounts; the contract never accepts caller-supplied output commitments.
- **Canonical registry:** one merged contract holds the single nullifier registry (no split registries
  → no double-spend risk).
- **Accepted roots only:** proofs must be made against a root in the on-chain root-history ring.
- **Durable state:** all fund-critical state is persistent/instance storage (never temporary), TTL
  bumped to max on write, with permissionless `keep_alive` heartbeats. See `implementation.md`.

## Status

Functionally complete and demonstrable end-to-end on testnet (un-hardened): atomic settle lifecycle,
the on-chain order book, and the Base → Stellar shield all validated live. The production-blocking
safety items (storage durability; worst case fits all per-tx resource limits) are done. The remaining
work is robustness and productionization — a crossed-book crank, bounded root-history eviction, keyed
book storage, an admin/pause surface, a nullifier accumulator to bound the one unbounded rent surface,
and making the vendored verifier build reproducible. **None of the open gaps can lose funds.** The full
list with rationale is in `implementation.md`.
