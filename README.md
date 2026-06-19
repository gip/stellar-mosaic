# stellar-mosaic

A privacy-preserving DEX on Stellar. Trade resting offers without leaking who owns
what, with non-custodial atomic settlement. Built on Soroban smart contracts, Noir
circuits, and a complete UltraHonk verifier using native BN254 Soroban host functions.

Start with [docs/architecture.md](docs/architecture.md). Detailed references:

- [docs/privacy-model.md](docs/privacy-model.md) - owner-anonymous, amount-transparent privacy model.
- [docs/note-types.md](docs/note-types.md) - asset and order note structures.
- [docs/lift-circuit-spec.md](docs/lift-circuit-spec.md) - production lift circuit: public-input vector and bindings.
- [docs/milestone-0-results.md](docs/milestone-0-results.md) - measurement/provenance log.

## Current status

A trade settles **atomically in one transaction** that verifies both sides' order proofs. In
addition, the contract now keeps an **on-chain resting limit-order book** (owner-anonymous; up to 64
orders per side per canonical pair) with cancellation, validity/expiry times, a per-order
partial-execution flag, and auto-matching on submit. See [docs/order-book.md](docs/order-book.md).

Measured facts (Stellar testnet):

- Verifier: `NethermindEth/rs-soroban-ultrahonk`.
- The per-transaction CPU limit is **400,000,000 instructions** (testnet and mainnet).
- One UltraHonk verify: ~**80M** (~20% of budget). Two verifies in one tx fit.
- `shield` (token custody + 1 on-chain tree insert): **~38M (~9%)**.
- Atomic `settle` (verify both order proofs, cross, record nullifiers, insert 2 proceeds notes):
  **230.5M (~58%)**.
- `unshield` (verify + recipient-bound payout): ~**81M** (~20%).
- Valid proofs accepted on testnet; corrupted/tampered proofs and replays rejected.

The note commitment tree is maintained **on-chain** (depth-32 append-only; `shield`/`settle` insert,
the root advances automatically, no admin publisher). The on-chain Poseidon `compress` is
byte-identical to the circuits (host `poseidon2_permutation` with `stellar/rs-soroban-poseidon`
constants, unit-tested against Noir). Each order proof (`circuits/lift`) binds every order field
settlement trusts; `settle` verifies two crossing proofs against on-chain roots and constructs
proceeds from the bound tags. Order matching is off-chain; settlement + the tree are on-chain. See
[docs/architecture.md](docs/architecture.md), [docs/tx-instruction-limit-spike.md](docs/tx-instruction-limit-spike.md),
and [docs/milestone-0-results.md](docs/milestone-0-results.md).

## Commands

Run the local prove/verify half:

```bash
./scripts/01_build_prove.sh
```

Run the integration test on the local Soroban host (real verifier, no testnet):

```bash
cd contracts/settlement && cargo test --test integration
```

This exercises the full custody loop — `shield` (token custody), atomic `settle` (verify two
crossing order proofs in one tx), and `unshield` (asset-note spend with the payout recipient bound
into the proof) — plus the negative cases (unpublished root, replayed settle, tampered order
field, incompatible orders, wrong unshield recipient). Proof fixtures live in
`contracts/settlement/tests/fixtures/` (see `regen.sh`). 14 tests, all green.

Current on-chain measurements are summarized in [docs/milestone-0-results.md](docs/milestone-0-results.md).
`scripts/02_deploy_verify_testnet.sh` is the legacy verifier spike script.

### Version pinning

The testnet-compatible artifact recipe uses:

| | required | installed here |
|--|----------|----------------|
| nargo | **1.0.0-beta.9** | 1.0.0-beta.3 |
| bb | **v0.87.0** | 0.82.2 |

`bb` proof format differs across versions, so mismatches can make valid proofs fail
verification. The legacy on-chain script installs the pinned pair into `~/.nargo`
and `~/.bb` and puts them first on PATH.

Confirmed artifact recipe:
- `bb prove/write_vk --scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields`
  (`bytes_and_fields` emits the separate `public_inputs` file the contract needs).

Confirmed contract interface:
- VK is set once at deploy via the constructor: `--vk_bytes-file-path target/vk`.
- Verify: `verify_proof --public_inputs-file-path ... --proof_bytes-file-path ...`.
- Build: `stellar contract build --optimize`, target `wasm32v1-none`.

## Layout

```
circuits/spend/      Noir spend circuit (Milestone 0 sizing spike)
circuits/lift/       order proof circuit (binds the full order; see docs/lift-circuit-spec.md)
circuits/unshield/   unshield proof circuit (recipient-bound asset-note spend)
contracts/settlement merged custody + matching: shield, atomic settle (2 verifies), unshield
scripts/             01 = local prove/verify; 02 = legacy on-chain verify spike
docs/                current design docs and measurement provenance
vendor/              verifier dependencies (gitignored)
artifacts/           proof + vk outputs (gitignored)
```
