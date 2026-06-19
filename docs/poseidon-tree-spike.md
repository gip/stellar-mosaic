# Spike: native Poseidon for the note Merkle tree (A vs C vs B)

Decides how the note commitment tree is built and how its root reaches the chain, now that
Protocol 25 (X-Ray) added native Poseidon host functions. Measured 2026-06-18.

## Background

`lift`/`unshield` prove Merkle membership of a note against a root we publish via `push_root`. Today
the tree is fully off-chain (the contract emits note fields and never hashes), and our tests use
synthetic hand-built trees. The question: should the tree (or at least the leaf hashing) move
on-chain now that Poseidon is a native host function?

Key structural fact: only **asset notes** live in the membership tree, and they are created only by
`shield` (cheap, no verify) and `settle` (proceeds/change). `lift` and `unshield` *consume* via
membership proof but **insert nothing**, so the ~81%-budget verify ops are unaffected by tree cost.

## Phase 0 - host API (local)

- `soroban-sdk 26.0.1` (our pin) exposes `env.crypto().poseidon_permutation(..)` and
  `poseidon2_permutation(..)` behind the `hazmat-crypto` feature. No SDK bump needed.
- They are fully parameterized permutation primitives (caller supplies field, `t`, `d`, round
  counts, internal diagonal, full round-constant table) - not a fixed hash.
- Stellar ships `stellar/rs-soroban-poseidon` (the blessed higher-level crate): `poseidon2_hash`
  and a reusable `Poseidon2Sponge`, README: **"Poseidon2: Matches noir's implementation."**

## Phase 1 - hash equivalence (the gate) - PASSED

The circuits hash with `poseidon2_permutation([a,b,0,0],4)[0]`. We need the on-chain hash to be
byte-identical or every membership proof fails. Cross-checked against the crate's own known-answer
test `test_poseidon2_permutation_bn254_t4` (input state `[0,1,2,3]`):

```
Noir  poseidon2_permutation([0,1,2,3],4) = [0x01bd538c..01737, 0x239b62e7..bac662, 0x04cbb44c..d5e3cb, 0x2e11c5cf..30847a]
crate test expected                       = [0x01bd538c..01737, 0x239b62e7..bac662, 0x04cbb44c..d5e3cb, 0x2e11c5cf..30847a]
```

**Identical, all four lanes.** On-chain Poseidon2 (via the host fn / the official crate) reproduces
our circuit's leaves and nodes exactly. So an on-chain tree or on-chain leaf hashing is feasible in
principle.

Build-time nuance: the crate's public API is a sponge `poseidon2_hash`; our `compress` is the raw
permutation's first lane. To match exactly we either vendor the crate's permutation/constants and
call the host permutation directly (lane 0), or switch the circuits to the crate's sponge hash
(cleaner, but regenerates circuits + fixtures + VKs). A construction choice, not a blocker.

## Phase 2 - cost (testnet)

Throwaway probe `Poseidon2Sponge::<4, Bn254Fr>`, reusing one sponge (constants initialized once),
measured via `build-only | tx simulate | tx decode`:

| Work | Instructions | ~% of ~100M budget |
|------|--------------|--------------------|
| 1 hash | 3,161,144 | ~3% |
| depth-32 insert (32 hashes) | 36,100,720 | ~36% |
| 4 inserts (128 hashes) | 138,107,148 | over budget |

Marginal cost ~1.06M instructions per Poseidon2 permutation; ~2.1M fixed per tx.

## Budget analysis

- **`shield`** (cheap base) + one depth-32 insert (~36M) -> fits comfortably.
- **`settle`** (base ~15M) + 2 inserts (~70M) -> ~85M, fits. + 4 inserts (partial fill: 2 proceeds +
  2 change, ~138M) -> **~150M, does NOT fit.**
- `lift`/`unshield` insert nothing -> unaffected.

So a full on-chain incremental tree is feasible for `shield` and full-fill `settle`, but **a
partial-fill `settle` that creates 4 leaves overflows the per-tx budget.** A depth-32 insert is also
a heavy ~36% tax on every note creation.

## Decision

> **RESOLVED (2026-06-18): Option A (on-chain tree) BUILT and validated on testnet.** Once the real
> per-tx limit turned out to be 400M (not 100M, see `tx-instruction-limit-spike.md`), the budget
> objection to an on-chain tree vanished. The contract now maintains the depth-32 tree itself.
> Measured on testnet: `shield` (1 insert) ~38M (~9%); `settle` (2 verifies + 2 proceeds inserts)
> 230.5M (~58%). Key implementation note: the Poseidon round-constant tables must be built ONCE per
> tx and reused across all compressions (rebuilding per hash added ~80M; see commit history). The
> on-chain `compress` is unit-tested byte-identical to Noir. The old Option-B analysis below is kept
> for provenance.

**Option B (off-chain builder + published root) - the pre-400M recommendation, superseded.** Phase 1 changed the calculus: leaf
hashing is now a *standardized, reproducible* function (official crate, matches Noir, verified
byte-exact), so the old determinism fear for B is largely gone - any builder using
`soroban-poseidon` computes identical leaves. B keeps zero hashing cost on-chain and never risks the
ceiling. Use **B3** (deterministic, self-reconstructable from public events so the builder is a
convenience, not a trust anchor) with a **B1** admin `push_root` publisher for v1.

**Option A (full on-chain tree) - rejected for v1.** Feasible but expensive (~36M per insert) and it
breaks on partial-fill `settle` (4 inserts > budget). Salvageable only by capping inserts/tx or
lowering tree depth (which shrinks capacity), not worth the tax and fragility.

**Option C (on-chain leaf compute, off-chain tree) - optional refinement.** Computing each note's
leaf on-chain costs only ~1 hash (~3M, fits everywhere) and makes the leaf value canonical from the
chain, so a buggy builder cannot corrupt leaves. Marginal benefit now that the hash is standardized;
keep as an optional integrity add-on to B, not a separate path.

## What this leaves to build (Option B)

- Off-chain indexer: ingest `shielded`/`settled` events in ledger order, compute leaves with
  `soroban-poseidon` (Noir-matching), maintain a depth-32 append-only tree, serve membership paths.
- Deterministic spec: empty-leaf constant + precomputed zero-hash ladder, fixed insertion ordering,
  shared by circuit and builder.
- `push_root` publisher (admin v1), with the tree reconstructable by anyone for self-serve/audit.
