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

Milestone 0 validated the key cost constraint on Stellar testnet: one real UltraHonk
verification fits, but two verifies in one transaction do not. The design therefore
uses verify-at-lift and proof-free atomic settlement.

Measured facts:

- Verifier: `NethermindEth/rs-soroban-ultrahonk`.
- One verify for the representative spend circuit: **79,922,355 CPU instructions**,
  about 80% of the ~100M per-transaction Soroban budget.
- Real lift with verify plus store: about **82%** of the budget.
- Proof-free settle consuming two lifted entries: about **10-13%** of the budget.
- Valid proofs were accepted on testnet; corrupted proofs were rejected.

The current settlement spike validates cost and flow shape. It is not final settlement
soundness yet: the spike circuit binds `[txbind, root, nullifier]`, but the production
lift circuit must bind every order field settlement trusts.

## Commands

Run the local prove/verify half:

```bash
./scripts/01_build_prove.sh
```

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
circuits/lift/       production lift circuit (binds the full order; see docs/lift-circuit-spec.md)
contracts/settlement settlement spike: verify at lift, proof-free settle
scripts/             01 = local prove/verify; 02 = legacy on-chain verify spike
docs/                current design docs and measurement provenance
vendor/              verifier dependencies (gitignored)
artifacts/           proof + vk outputs (gitignored)
```
