# ZK benchmarks & cost measurements

Every proof-verification, settlement, and order-book cost measurement lives here, plus the provenance
log that explains the verifier choice. Design conclusions are in `architecture.md`; this file is the
numbers and how they were obtained.

All figures are **CPU instructions measured on Stellar testnet** unless marked "local host". Read
costs straight from the assembled tx `SorobanResources` — the RPC `cost.cpu_insns` field reads 0 on
this protocol version, so decode the tx data instead.

## The per-transaction budget (it is 400M, not 100M)

Measured 2026-06-18. Supersedes the ~100M assumption that Milestone 0 and several early decisions
were built on. From `stellar network settings` (`contract_compute_v0`), identical on **testnet and
mainnet**:

| setting | value |
|---|---|
| `tx_max_instructions` (per-tx CPU cap) | **400,000,000** |
| `ledger_max_instructions` (per-ledger) | 580,000,000 |
| `tx_memory_limit` | 41,943,040 (40 MiB) |
| `fee_rate_per_instructions_increment` | 7 stroops |

These are validator-voted and adjustable. The raise (from the old ~100M) lines up with Protocol 25
(X-Ray), which also added the BN254/Poseidon ZK host functions.

### The simulator gap (important)

The RPC simulator and the enforced network cap are **not** the same number:

- The simulator reports the true metered instruction count, linearly, with no clamping. Probe fit:
  `declared = 2,098,572 + n × 1,062,567` exactly at every `n`.
- But the simulator runs with a **higher CPU budget (~416M)** than the enforced 400M. A tx metering
  400M–416M **simulates cleanly yet is rejected at submission**, and the CLI does not auto-clamp.

| n (probe `insert_like`) | declared instr | simulate | submit |
|---|---|---|---|
| 374 | 399,498,630 (<400M) | OK | accepted + executed on-chain |
| 375 | 400,561,197 (>400M) | OK | (would be rejected) |
| 389 | 415,437,124 | OK | rejected: `TxSorobanInvalid` |
| 390 | ~416,499,691 | `Budget/ExceededLimit` | — |

**Rule: design to 400,000,000. Do not trust "simulation passed" near the ceiling** — check declared
instructions ≤ 400M and be ready to set resources manually for txs close to the limit.

Caveats: fits ≠ free (the non-refundable fee scales with instructions at 7 per 10k, so a 160M tx
costs ~2× an 80M tx); the per-ledger cap is 580M (~3 of a 160M settle per ledger, a throughput
ceiling for scale, not v1); a two-verify tx's memory use (40 MiB cap) is likely fine but unmeasured.

## Current measured costs (the headline numbers)

| operation | instructions | % of 400M | notes |
|---|---|---|---|
| one UltraHonk verify | ~80M | ~20% | fixed; proof padded to `CONST_PROOF_SIZE_LOG_N=28` |
| `shield` (1 tree insert) | 37.7M | ~9% | |
| atomic `settle` (2 verifies + 2 proceeds inserts) | 230.5M | ~58% | ~160M verify + ~70M inserts |
| `unshield` (verify + recipient-bound payout) | 81.3M | ~20% | |
| `submit_order` resting (no fill) | 84.2M | ~21% | verify + book load/store |
| `submit_order` 2-fill | 220.4M | ~55% | |
| `cancel_order` | 115.2M | ~28% | |
| order-book worst case (full book + 4-fill cap) | 359.8M | ~89% | accepted; ~11% margin |
| depth-32 Poseidon insert | 36M | ~9% | ~1.06M per permutation, ~2.1M fixed/tx |

Sources: `scripts/06_book_budget_testnet.sh` (book), `scripts/07_book_worstcase_testnet.sh` (worst
case), the e2e demo scripts (`03`/`04`), and the provenance log below.

## Poseidon tree-insert cost (testnet probe)

A depth-32 incremental insert is 32 `compress` calls. Throwaway probe `Poseidon2Sponge::<4, Bn254Fr>`
reusing one sponge (constants initialized once):

| work | instructions | ~% of 400M |
|---|---|---|
| 1 hash | 3,161,144 | ~0.8% |
| depth-32 insert (32 hashes) | 36,100,720 | ~9% |
| 4 inserts (128 hashes) | 138,107,148 | ~35% |

Marginal cost ~1.06M instructions per Poseidon2 permutation; ~2.1M fixed per tx.

**Implementation lesson:** build the Poseidon round-constant tables **once per tx** (a `Hasher`) and
reuse across all compressions. Rebuilding them per hash cost ~80M extra (settle was 313M → 230.5M).
Keep VKs + tree state in persistent storage (not instance) so tree writes don't re-serialize the
~1.7 KB VKs.

## Order-book worst case (the ~89% measurement)

`MAX_FILLS_PER_SUBMIT = 4`. The absolute worst case — a full 64-deep book + a taker filling the
4-fill cap (8 proceeds inserts) — was measured directly on testnet at **359.8M instructions (~89% of
400M)** and **accepted** (`scripts/07_book_worstcase_testnet.sh`; tx `8306fbb3…`, contract
`CBLRBC6A…`). Margin is ~11%: **do not raise the cap without re-measuring**. (Local-host reference:
~316M at cap 4, ~251M at cap 3.)

Non-CPU resources for that same tx: `write_bytes` = **25,776** (~20% of the ~130 KB per-tx cap),
`disk_read_bytes` = **0**. Under Protocol 23's in-memory state model, TTL-live entries are read from
memory and don't count against the read-bytes limit — so keeping state bumped (see the storage
section of `implementation.md`) also keeps reads free. The network accepts a tx only if it is under
*every* per-tx cap, so acceptance confirms the worst case fits instructions, write/read bytes, and
entry counts.

Cost model: `submit_order ≈ 80M (verify) + (2·fills + IOC?)·40M (inserts) + book load/store`. The
real driver is proceeds inserts, not book depth — loading a full 64-deep side is ~58M local
(monolithic `Vec` (de)serialization), independent of fills.

---

# Provenance log (how the verifier was chosen)

Historical, retained because it explains the verifier choice. The current conclusion: a complete,
sound, already-native UltraHonk verifier (`NethermindEth/rs-soroban-ultrahonk`) fits at ~80M per
verify; with the real 400M budget, two verifies in one atomic `settle` fit comfortably.

## Production lift circuit on-chain (measured 2026-06-18)

- Toolchain: nargo 1.0.0-beta.9, bb 0.87.0 (pinned), `--scheme ultra_honk --oracle_hash keccak
  --output_format bytes_and_fields`.
- Circuit `circuits/lift` (depth-32 Merkle + Poseidon ownership/nullifier + order-leaf bind + lift
  domain separator): 3,335 gates, 206 ACIR opcodes; proof 14,592 bytes; VK 1,760 bytes.
- **Verify cost: 80,641,857 CPU** (~80.6% of the old ~100M frame), only **+0.9%** over the depth-5
  spend spike (79,922,355) — depth and the extra order-leaf hash barely move verify cost because the
  UltraHonk proof is padded to `CONST_PROOF_SIZE_LOG_N=28` regardless of gate count. Valid proof
  accepted; corrupted proof (4 bytes flipped at offset 5000) rejected `Error(Contract, #4)`
  `VerificationFailed`. Deployed testnet `CC6OVSTVKCFJLGF3O7FSDFZR3XQC2TRTFYT6WW6P4VMIENMM64YKZMHC`.
- Full `lift` (verify + domain + root + nullifier + store): **81,156,293 CPU (~81.2%)** — only ~0.5%
  over pure verify; the binding/storage logic is cheap.

## Custody: shield + unshield (validated 2026-06-18)

- `unshield` binds the payout recipient: public input `[5]` must equal `sha256(to.to_xdr())` with the
  top byte zeroed (a field < 2^248), so a relayer cannot redirect funds (`unshield_rejects_wrong_recipient`
  → `#15 RecipientMismatch`). Real unshield on testnet (`CDZEWBXDDT44SRSZIZ2Z4S5DTRMVWLRAFG5D5WBT726CA4I3KPW6GK3N`,
  native XLM as asset 1): **81,284,416 CPU (~81.3% of the old frame; ~20% of 400M)**. The ~80M verify
  dominates; sha256 + token transfer + nullifier write add well under 1M.
- `shield` exercised on the local host (real Stellar Asset Contract): tokens move into custody and a
  `shielded` event is emitted.

## Atomic single settlement (validated 2026-06-18)

After confirming the per-tx limit is 400M, the verify-at-lift / settle-cheap split was collapsed into
one atomic `settle` that verifies BOTH order proofs in one tx (the `lift` entrypoint, `PoolEntry`
storage, and `DataKey::Entry` were removed; matching moved off-chain).

- Two-verify `settle` (contract `CDITYAB32OQUS7ZR7EE3EVWPI5ZAIVUDTDAPFB4CGZ2UE57MTJOEY2L5`):
  **160,807,406 CPU (~40.2%)** before the on-chain tree. Emitted the correct bound proceeds (A: 2000
  of asset 2 → tag 0x2329; B: 100 of asset 1 → tag 0x232b); replay rejected `#3 NullifierUsed`.
- With the on-chain depth-32 tree (2 proceeds inserts added): **230,529,644 CPU (~57–58%)** =
  ~160M two verifies + ~70M two inserts. Validated end-to-end on testnet 2026-06-18: shield A + shield
  B reproduced the exact on-chain root the order proofs were made against (`19a1a766…1a93e`), and
  `settle` accepted with no `push_root`; the recipient's balance rose by exactly the 2000 unshielded.

## Local proof spike (validated 2026-06-16)

- Toolchain: nargo 1.0.0-beta.3, bb 0.82.2. Circuit `circuits/spend` (depth-5 Merkle + Poseidon
  hash-lock + nullifier + txbind): **818 gates**, 45 ACIR opcodes; proof ~14 KB; VK ~1.8 KB. Valid
  proof verifies locally; corrupted proof rejected locally.

## First on-chain attempt: indextree verifier (2026-06-16) — FAILED

- `indextree/ultrahonk_soroban_contract` @ `5c32a28`, nargo 1.0.0-beta.9 / bb v0.87.0, keccak oracle.
  Circuit 967 gates; wasm 50.9 KB (well under the 128 KiB limit). Local prove+verify pass; deployed
  to testnet (`CC5UPX27ZTQI52S3IWNSQPE2HSL4Z3S7EMH6S72NIYVWW6WLY2ICPW5O`). On-chain `verify_proof`:
  `HostError: Error(Budget, ExceededLimit)`. Verdict: contract size was not the blocker; this
  verifier implementation exceeded the budget.

## Nethermind verifier (confirmed 2026-06-16)

- `NethermindEth/rs-soroban-ultrahonk` (`crates/ultrahonk-soroban-verifier`), commit `661db07`.
  Default/tornado circuit verified on-chain (`CAXLUR57…`, tx `e9a8261b…`): "Proof successfully
  verified on-chain!" Then bound to our `circuits/spend` VK (`CAU63XJS…`): valid 967-gate proof (3
  public inputs / 96 bytes) accepted (tx `4d11eb55…`); corrupted proof rejected at simulation
  `Error(Contract, #4)`, never submitted. Our artifacts were format-compatible with no rebuild
  (Nethermind's `build_all.sh` uses the same `--scheme ultra_honk --oracle_hash keccak
  --output_format bytes_and_fields`).
- Cost for our spend circuit: **79,922,355 CPU**, 0 ledger read/write bytes (pure compute), min
  resource fee 137,525 stroops (~0.0138 XLM, actual ~122,888), tx envelope 15,052 bytes.

## Verifier landscape

Stellar Protocol 25 added native BN254 host functions (`g1_add`, `g1_mul`, `g1_neg`,
`fr_from_bytes`, `pairing_check`). Source review of Nethermind's verifier confirmed it is
native-BN254 throughout (`field.rs` uses `Bn254Fr`/`env().crypto().bn254()`; `ec.rs` uses `g1_msm`
and `pairing_check`) with a complete pipeline (`sumcheck.rs`, `shplemini.rs`, `relations.rs`,
`transcript.rs`). So the measured ~80M is a complete, sound, already-native verifier — no easy
software-to-native 2× win left for UltraHonk.

| verifier | EC backend | sound | cost |
|---|---|---|---|
| indextree / yugocabrio | arkworks software (WASM) | yes | >100M, failed |
| Nethermind | native host functions | yes | **79.9M measured** |
| salazarsebas UltraHonk | native host functions | **no** (simplified stub) | ~35M modeled |
| salazarsebas Groth16 | native host functions | yes | ~12M (needs per-circuit trusted setup) |

The salazarsebas UltraHonk template performed only a simplified final KZG pairing check on
prover-controlled bytes (no Fiat-Shamir transcript, no sumcheck, no MSM), so ~35M is not comparable.
The remaining alternatives are architectural (recursive aggregation; or Groth16 if per-circuit
trusted setup is accepted), not an immediate verifier swap.

## Groth16-on-Soroban spike (Base bridge, WS3)

A BN254 Groth16 verify fits the budget at **~26M CPU (~6.6%)** (`contracts/groth16_spike/`),
confirming the Base-bridge receipt verification path is feasible. Production verification uses the
Nethermind `stellar-risc0-verifier` router; see `base-bridge.md`.
