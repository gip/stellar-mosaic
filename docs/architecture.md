# Architecture: atomic settlement

This is the entry-point design document for Stellar Mosaic. See `privacy-model.md` for the privacy
model, `note-types.md` for concrete note structures, `tx-instruction-limit-spike.md` for the budget,
and `milestone-0-results.md` for measurement provenance.

## Current verdict

The v1 design is **owner-anonymous and amount-transparent**:

- Public: note asset/amount, order pair/price/size, matches, fill amounts, and timing.
- Hidden: the owner behind each note/order, the create-to-spend link, and which note a spend consumed.
- A trade settles **atomically in one transaction** that verifies both sides' order proofs.
- UltraHonk is used for order/unshield proofs, with no per-circuit trusted setup.

The privacy claim is "no direct owner/wallet linkage inside the pool," not amount privacy. Amounts
and timing remain followable; standard denominations and delayed unshields are privacy mitigations,
not complete fixes.

## Budget and the settlement shape

The per-transaction CPU limit is **400,000,000 instructions** (testnet and mainnet; see
`tx-instruction-limit-spike.md`). One UltraHonk verify is ~80M (~20%), so **two verifies in one tx
(~160M, ~40%) fit comfortably**. A two-sided trade is therefore a single atomic transaction:

```
TX: settle    verify order proof A + verify order proof B, check they cross,
              record both nullifiers, emit proceeds  (measured 160.8M = ~40% of budget)
```

This replaces the earlier verify-at-lift / settle-cheap design (a 3-tx maker-lift / taker-lift /
settle dance with on-chain resting order entries), which existed only because we wrongly believed
the limit was ~100M. With the real 400M budget the split is unnecessary.

The **order book is off-chain**: a party generates an order proof (the lift circuit) and hands it to
a matcher; the matcher pairs two crossing proofs and submits `settle`. Order data (pair/price/size)
is public anyway, so a lit off-chain book preserves the "lit pool" property while settlement stays
on-chain and atomic (the Renegade-style off-chain-book / on-chain-settlement shape).

## Contracts and state

One merged contract, `contracts/settlement`, owns custody, the nullifier registry, matching, and
settlement (registry-ownership DECIDED: a split Assets/Desk design would add a cross-contract call,
and is not needed). Roles:

- **Custody:** holds real Soroban tokens (`shield`/`unshield`), keyed by an admin-registered
  asset-id -> token map; maintains the canonical nullifier registry and published roots.
- **Desk:** atomic matching/settlement (`settle`).

Supported assets are admin-gated. USDC and XLM can be native Stellar/Soroban assets. ETH and XRP
require wrapped issuers or bridge integrations before they can be custodied.

## Flow

1. **Shield** (IMPLEMENTED: `shield` + `register_asset`)
   - User transfers a supported asset into custody; the contract mints an active
     `AssetNote { asset, amount, owner_tag }` by inserting `Poseidon(asset, amount, owner_tag)` into
     the **on-chain** Merkle tree (the root advances and is accepted), and emits a `shielded` event
     so an off-chain client can rebuild membership paths.
   - Proof-free: the token transfer enforces the amount and amounts are public. Measured ~38M (~9%).

2. **Order** (off-chain; proof = `circuits/lift`)
   - A party generates an order proof: proves membership of an asset note in the tree, reveals its
     nullifier, and binds the order terms (`asset_in`, `amount_in`, `asset_out`, `min_out`,
     `output_owner_tag`). No on-chain step; the proof is handed to a matcher.
   - The order is firm in the sense that the proof authorizes consuming that note; the maker
     "cancels" by spending the note another way (e.g. `unshield`), which nullifies it and makes the
     held proof unusable. No on-chain cancel entrypoint is needed.

3. **Settle** (IMPLEMENTED: `settle`, atomic, two verifies)
   - A matcher submits two crossing order proofs. The contract verifies BOTH, derives each order
     from its verified public inputs, checks asset + price compatibility in plaintext, requires the
     two notes to be distinct and unspent, records both nullifiers, and emits proceeds descriptors
     stamped with each order's bound `output_owner_tag`.
   - Proceeds are minted as new asset notes by inserting them into the on-chain tree (no
     caller-supplied output commitments). No proof-free pre-verified entries.
   - Measured on testnet at **230.5M instructions (~58% of the 400M budget)**: ~160M for the two
     verifies plus ~70M for the two proceeds inserts.

4. **Unshield** (IMPLEMENTED: `unshield`, circuit `circuits/unshield`)
   - User spends an asset note with a proof that binds the payout **recipient** (public input
     `[5] == sha256(to.to_xdr())`, top byte zeroed), so a relayer can submit but cannot redirect.
   - Contract records the nullifier, then transfers the public `asset`/`amount` to `to`.
   - Per-operation VKs: `set_vk(op, vk)` registers the unshield VK (op 2) alongside the order VK
     (op 1, set at construction). Measured on testnet at ~81.3% of budget.

## End-to-end demo

`scripts/03_demo_e2e.sh` + `contracts/settlement/tests/e2e_demo.rs` run the FULL lifecycle with real
UltraHonk proofs whose membership witnesses are reconstructed by the path server: A shields asset 1,
trades into asset 2 via an atomic `settle`, then **unshields the proceeds note `settle` created** —
a note that exists only as a tree leaf, whose Merkle path the indexer rebuilds from the
shield+settle event history (impossible without the path server). The script derives every
`Prover.toml` field (owner tags, nullifiers, order leaf, recipient binding, path) via the `witness`
tool; the test executes shield→settle→unshield against the contract on the local host and checks
custody/recipient balances. Run: `./scripts/03_demo_e2e.sh` then `cargo test -p settlement`.

`scripts/04_demo_e2e_testnet.sh` is the authoritative TESTNET version: it deploys the contract and
submits the same flow as real transactions, reusing the local-host proofs unchanged (they bind the
protocol asset-id and the Merkle root, not token addresses, and the on-chain tree is deterministic,
so shielding the same notes reproduces the exact roots R2/R4 the proofs were made against). Both
protocol asset-ids map to the native XLM SAC for a robust run (the protocol distinguishes them by
id; two real tokens would only add issuance/trustline setup). Validated on testnet 2026-06-18: the
on-chain root after the shields equalled proof A's bound root; **atomic settle = 230,529,644 CPU
(~57% of 400M; ~160M two verifies + ~70M two proceeds inserts), unshield = 81,755,747 CPU (~20%)**;
the recipient's balance rose by exactly the 2000 unshielded.

## Soundness invariants

- **Full binding in the order proof:** each order proof binds its consumed nullifier, `asset_in`,
  `amount_in`, `asset_out`, `min_out`, `output_owner_tag`, the membership `root`, and a domain
  separator. `settle` trusts nothing the caller passes outside the verified public inputs.
- **Both sides verified:** `settle` verifies both proofs before any state change.
- **Distinct, unspent notes:** the two sides must have different nullifiers, both unused; both are
  recorded before proceeds are emitted (single-use).
- **Settlement constructs outputs:** proceeds are built from the bound `output_owner_tag` and the
  matched fill amounts; the contract never accepts caller-supplied output commitments.
- **Canonical registry:** one merged contract holds the single nullifier registry (no split
  registries -> no double-spend risk).
- **Published roots only:** proofs must be made against an admin-published Merkle root.

## Open implementation gaps

- **On-chain Merkle tree (DONE):** the contract maintains the depth-32 append-only tree itself
  (`shield`/`settle` insert; root advances and is accepted automatically; no admin `push_root`). The
  on-chain `compress` is byte-identical to the circuits (host `poseidon2_permutation` with the
  `stellar/rs-soroban-poseidon` BN254 t=4 constants; unit-tested against Noir). Validated end-to-end
  on testnet: shield A + shield B reproduce the exact root the order proofs were made against, then
  `settle` accepts them with no push_root.
- **Path-server client (DONE):** `tools/indexer` (crate `mosaic-indexer`) is a read-only off-chain
  indexer that rebuilds membership paths from `shielded`/`settled` events (the tree stores only
  filled subtrees on-chain, not all leaves). It is NOT a trust anchor — the on-chain root is. It
  reuses the contract's exact `compress` (host `poseidon2_permutation` + `soroban-poseidon` BN254
  t=4 constants, via a local `Env` as a hash engine), so its roots are byte-identical by
  construction. API: `NoteTree::{ingest_shielded, ingest_settled, root, path, circuit_fold}`; the
  `witness` bin replays an event log on stdin and prints `Prover.toml` path/index_bits witnesses
  (this is what makes `tests/fixtures/regen.sh` reproducible and what a wallet calls before proving).
  Cross-checked in `contracts/settlement/tests/integration.rs`: the indexer's reconstructed root
  equals the on-chain `root()` AND the root the committed order/unshield proofs were generated
  against, and every indexer-derived path folds (via the circuit's membership algorithm) back to
  that root.
- **Root history is unbounded:** every produced root stays accepted (nullifiers prevent
  double-spend regardless of root recency); a bounded ring is a later refinement.
- **Partial fills:** `settle` is full-fill (each side receives the other's offered amount). Partial
  fills need fill-amount math plus proceeds + change notes per side.
- **Order circuit naming:** `circuits/lift` is the order proof; the contract has no `lift`
  entrypoint anymore. `order_leaf`/`cancel_owner_tag` public inputs are currently unused on-chain.
- **Wrapped assets:** define issuers/bridges before advertising ETH/XRP support.
- **Standalone build:** the contract depends on a vendored Nethermind verifier path that is
  gitignored; make it reproducible before treating it as a buildable package.
- **Recovery:** users hold note secrets; losing them loses access until a recovery design exists.
