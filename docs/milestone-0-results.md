# Milestone 0 - results and measurement log

This is the provenance log for the proof-verification and settlement-cost measurements. The current
design conclusion is summarized first; historical failed paths are retained below because they
explain the verifier choice.

## Current conclusion

- A complete, sound UltraHonk verifier fits on Stellar testnet when using
  `NethermindEth/rs-soroban-ultrahonk`.
- Nethermind's verifier is already native-BN254 and complete; the measured cost is the optimized
  path, not a software fallback.
- One verify for our spend circuit costs **79,922,355 CPU instructions** (~79.92% of the ~100M
  per-transaction Soroban limit).
- Two UltraHonk verifies in one transaction are infeasible.
- The working architecture is therefore: one verifying `lift` per side, then proof-free atomic
  `settle`.
- The current settlement spike validates cost and transaction shape, but not final settlement
  soundness. The spike circuit binds only `[txbind, root, nullifier]`; the final lift circuit must
  bind all order fields that settlement trusts.
- **The production lift circuit (`circuits/lift`, full order binding, `TREE_DEPTH=32`) was measured
  and FITS: 80,641,857 CPU instructions (~80.6% of budget) — only +0.9% over the depth-5 spend
  spike.** Depth and the extra order-leaf hash barely move verify cost because the UltraHonk proof is
  padded to `CONST_PROOF_SIZE_LOG_N=28` regardless of actual circuit size. The budget headroom for
  verify-at-lift therefore holds at production depth.

## Production lift circuit on-chain (measured 2026-06-18)

- Toolchain: nargo 1.0.0-beta.9, bb 0.87.0 (pinned), `--scheme ultra_honk --oracle_hash keccak
  --output_format bytes_and_fields`.
- Circuit: `circuits/lift` (depth-32 Merkle + Poseidon ownership/nullifier + 6-field order-leaf bind
  + lift domain separator). 3,335 gates, 206 ACIR opcodes. Proof 14,592 bytes; 10 public inputs
  (320-byte `public_inputs`); VK 1,760 bytes.
- Verifier: `NethermindEth/rs-soroban-ultrahonk` wrapper contract, lift VK set at constructor.
  Deployed testnet `CC6OVSTVKCFJLGF3O7FSDFZR3XQC2TRTFYT6WW6P4VMIENMM64YKZMHC`.
- **Verify cost: 80,641,857 CPU instructions** (resources: 0 disk read/write bytes, resource fee
  139,106 stroops; non-refundable 124,179). Read straight from the assembled tx `SorobanResources`
  (the RPC `cost.cpu_insns` field reads 0 on this protocol version — decode the tx data instead).
- Valid proof: ACCEPTED (return `null`/`Ok`). Corrupted proof (4 bytes flipped at offset 5000):
  REJECTED on-chain with `Error(Contract, #4)` = `VerificationFailed`.
- Conclusion unchanged: one verify per lift fits (~80.6%); two verifies in one tx (~161M) remain
  infeasible; verify-at-lift + proof-free settle stands at production depth.

## Settlement contract wired to the lift vector (validated 2026-06-18)

`contracts/settlement` `lift` now derives EVERY order field from the verified 10-field public-input
vector (nothing the caller passes is trusted), checks the `lift` domain separator, requires the
membership `root` to be admin-published (`push_root`), and records the consumed asset note's
nullifier at lift (nullify-at-lift). `settle` consumes two entries with no proof, crossing the bound
fields in plaintext and stamping each order's bound `output_owner_tag` onto the fill amount.

- Deployed testnet `CAAYPMQ667KTHQRTZXGPZISXF4QZS46TN34HE447CKQNZMN7Y5AY7XN6` (lift VK + admin).
- Full lift (verify + domain + root + nullifier + store) cost on a fresh instance
  (`CD36BPNF...A4VSG`): **81,156,293 CPU (~81.2% of budget)**, 0 disk read, 640 write bytes, resource
  fee 223,870 stroops. Only ~0.5% over pure verify (80.64M); the binding/storage logic is cheap.
- End-to-end checks, all as expected:
  - lift before the root is published -> `Error(Contract, #10)` `UnknownRoot`.
  - lift with a valid proof -> `Ok`.
  - re-lift the same proof (same nullifier) -> `#3` `NullifierUsed`.
  - **lift a valid proof with one byte of `amount_in` tampered -> `#8` `VerificationFailed`** (the
    proof binds every order field, so order terms cannot be substituted).
  - two compatible orders (A: 100 of asset 1 wanting >=1500 of asset 2; B: 2000 of asset 2 wanting
    >=50 of asset 1) -> `settle` `Ok`, emits both proceeds descriptors.
  - re-settle the same pair -> `#2` `AlreadyConsumed`.

## Local proof spike (validated 2026-06-16)

- Toolchain: nargo 1.0.0-beta.3, bb 0.82.2
- Circuit: `circuits/spend` (depth-5 Merkle + Poseidon hash-lock + nullifier + txbind)
- Circuit size: **818 gates**, 45 ACIR opcodes
- Proof size: **~14 KB** (ultra_honk, poseidon2 oracle)
- VK size: **~1.8 KB**
- Valid proof verifies locally: YES
- Corrupted proof rejected locally: YES

## First on-chain attempt: indextree verifier (measured 2026-06-16)

- Verifier repo: `indextree/ultrahonk_soroban_contract` @ commit `5c32a28`
- Toolchain pinned to match it: nargo **1.0.0-beta.9**, bb **v0.87.0**
- Oracle hash: **keccak**, output format `bytes_and_fields`
- Circuit: 967 gates; proof 14.6 KB; public inputs 96 B (3 fields); VK 1.76 KB
- Contract wasm: **50.9 KB** optimized, well under the 128 KiB contract-size limit
- Local prove + verify: PASS
- Corrupted proof rejected locally: PASS
- Deploy to testnet: SUCCESS
  - Contract: `CC5UPX27ZTQI52S3IWNSQPE2HSL4Z3S7EMH6S72NIYVWW6WLY2ICPW5O`
  - VK set at construction
- Single on-chain `verify_proof`: FAIL
  - `HostError: Error(Budget, ExceededLimit)`

Verdict: contract size was not the blocker. This verifier implementation exceeded the Soroban
transaction budget.

## Nethermind verifier: default circuit pass

Nethermind run (commit `661db07`, same nargo 1.0.0-beta.9 / bb 0.87.0):

- Verifier: `NethermindEth/rs-soroban-ultrahonk`
  (`crates/ultrahonk-soroban-verifier`)
- Deployed: `CAXLUR57WF67ACRMIS2W5TJWU3J6KFOSHV2BN443CU2NIGLLJIRULIFX`
- Proof: 14,592 bytes
- Public inputs: 32 bytes (their default/tornado circuit)
- `verify_proof` simulated within budget and submitted
- Tx: `e9a8261b0793c34a8c58c725e7ab40a212afca82ac456e60d1e7c248c826fb5f`
- Result: "Proof successfully verified on-chain!"

This established that a single UltraHonk verification can fit on Stellar testnet when the verifier
implementation is optimized.

## Our spend circuit on Nethermind verifier (confirmed 2026-06-16)

Deployed Nethermind verifier bound to our `circuits/spend` VK:

- Contract: `CAU63XJSNFZXFYDTNRLBOF3QFNUNKXPM5EXWCK36FFF5UOMVU65V67JA`
- Valid proof (967-gate spend circuit, 3 public inputs / 96 bytes): accepted and submitted
- Tx: `4d11eb55555c06a2efa74af29e51cdf79260719a05b8574aa51ef743e02fcddb`
- Corrupted proof: rejected at simulation
  - `HostError: Error(Contract, #4)` (verifier invalid-proof error)
  - Never submitted

Our artifacts were format-compatible with no rebuild: Nethermind's `build_all.sh` uses the same
`--scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields`.

Cost measured for our spend circuit:

| Metric | Value |
|--------|-------|
| CPU instructions (one verify) | **79,922,355 = 79.92% of the ~100M per-tx limit** |
| Ledger read/write bytes | 0 (pure compute; real contracts add storage I/O) |
| Min resource fee | 137,525 stroops (~0.0138 XLM); actual charged ~122,888 (~0.0123 XLM) |
| Tx envelope size | 15,052 bytes (proof 14,592 + public inputs 96 + overhead) |

Implication: the old design that verified maker and taker proofs in one atomic settlement
transaction would cost about 160M CPU instructions, or ~160% of the transaction limit. That path is
not viable.

## Settlement spike: verify-at-lift, settle-cheap (2026-06-17)

First settlement contract spike (`contracts/settlement`) separated expensive verification from
cheap settlement:

- Deployed: `CDPW6NQHESKBHYERDY5XBPLMEICLM3H6V4ZB7A5F33RXUFEWCJLTYZTS`
- Ran 2 lifts + 1 settle
- `settle` succeeded and emitted the `settled` event with both output commitments

Non-refundable resource fee, CPU-dominated:

| Operation | Non-refundable fee | vs one verify |
|-----------|--------------------|---------------|
| UltraHonk verify (measured) | 122,698 stroops | 100% (~79.9M CPU) |
| lift (store entry, no verify) | 6,844 stroops | ~6% |
| settle (consume two, no verify) | 15,955 stroops | ~13% |

Conclusion:

- `lift` transaction = verify (~80% budget) + store (~5-6%) -> fits.
- `settle` transaction = no verify, about 10-13% of budget -> fits with large margin.
- Two lifts in separate transactions plus one settle are feasible.

## Real lift settlement spike (2026-06-17)

The next spike made `lift` call Nethermind's verifier in-process and store the entry only if the
proof verified. The stored nullifier was bound to the proof's public inputs.

- Contract: `contracts/settlement`
- Deployed with our spend-circuit VK:
  `CC23Q4KSMUDN5TBXXNSFXTWHTT2U3ZDYNLH3UH65JFKTP2MXEECL346E`
- Lift A (verify proof A + store, id 1): submitted
  - Non-refundable CPU fee: **126,454 stroops**
  - One verify baseline: 122,698 stroops
  - Delta is the pool-entry store
  - About **82%** of the per-transaction budget
- Lift with corrupted proof: rejected
  - `Error(Contract, #8) = VerificationFailed`
  - Nothing stored
- Lift B (verify proof B + store, id 2): submitted
- `settle(1, 2)` (no verify): submitted
  - Emitted `settled` with both output commitments
  - Non-refundable CPU fee: **16,549 stroops**
  - About 13% of a verify, or about 10-11% of budget

Result: a complete two-sided private-trade shape is feasible as two verifying lift transactions
(~82% budget each, separate transactions) plus one cheap settle (~11% budget).

Important caveat: this spike circuit binds only `[txbind, root, nullifier]`. Stored
asset/amount/price/output fields are not yet proof-bound, so this validates cost and flow, not final
settlement soundness. The settlement contract also depends on a vendored Nethermind verifier path
that is gitignored, so it is not yet standalone-reproducible.

## Verifier landscape corrections

Stellar Protocol 25 introduced native BN254 host functions:

- `g1_add`
- `g1_mul`
- `g1_neg`
- `fr_from_bytes`
- `pairing_check`

The final source review of Nethermind's verifier showed:

- `crates/ultrahonk-soroban-verifier/Cargo.toml`: only dependency is `soroban-sdk`; no arkworks.
- `field.rs`: uses `soroban_sdk::crypto::bn254::Bn254Fr` and `env().crypto().bn254()` field ops.
- `ec.rs`: uses `env.crypto().bn254().g1_msm(...)` and `.pairing_check(...)`.
- Complete pipeline exists: `sumcheck.rs`, `shplemini.rs`, `relations.rs`, `transcript.rs`.

So the measured **79.9M** is a complete, sound, already-native UltraHonk verifier. There is no easy
software-to-native 2x win left for UltraHonk.

Final verifier table:

| Verifier | EC backend | Sound | Cost |
|----------|------------|-------|------|
| indextree / yugocabrio | arkworks software (WASM) | yes | >100M, failed |
| Nethermind | native host functions | yes | 79.9M measured |
| salazarsebas UltraHonk | native host functions | no, simplified stub | ~35M modeled |
| salazarsebas Groth16 | native host functions | yes | ~12M |

The salazarsebas UltraHonk template was not a complete verifier: it performed only a simplified
final KZG pairing check on prover-controlled proof bytes, with no Fiat-Shamir transcript, no
sumcheck verification, and no MSM computation. The ~35M figure is therefore not comparable to the
complete Nethermind verifier. Their Groth16 path is sound but requires a per-circuit trusted setup.

Remaining alternatives are architectural, not an immediate verifier swap:

- Keep UltraHonk and use verify-at-lift / proof-free settlement.
- Use recursive aggregation if a single aggregated UltraHonk proof is later feasible.
- Use Groth16 if the project accepts per-circuit trusted setup.
