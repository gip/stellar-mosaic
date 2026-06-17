# Milestone 0 - results

The kill-switch experiment: can a real-sized UltraHonk proof be verified on Stellar
testnet within Soroban limits? Record findings here as they come in.

## Local (validated 2026-06-16)

- Toolchain: nargo 1.0.0-beta.3, bb 0.82.2
- Circuit: `circuits/spend` (depth-5 Merkle + Poseidon hash-lock + nullifier + txbind)
- Circuit size: **818 gates**, 45 ACIR opcodes
- Proof size: **~14 KB** (ultra_honk, poseidon2 oracle)
- VK size: **~1.8 KB**
- Valid proof verifies locally: YES
- Corrupted proof rejected locally: YES

## On-chain (testnet) - measured 2026-06-16

- Verifier repo: indextree/ultrahonk_soroban_contract @ commit `5c32a28`
- Toolchain pinned to match it: nargo **1.0.0-beta.9**, bb **v0.87.0**
- Oracle hash: **keccak**, output format `bytes_and_fields`
- Circuit: 967 gates; proof 14.6 KB; public_inputs 96 B (3 fields); vk 1.76 KB
- Contract wasm: **50.9 KB** optimized -> well under the 128 KiB contract-size limit.
  **Contract size is NOT the blocker.**
- Local prove + verify: PASS. Corrupted proof rejected: PASS.
- Deploy to testnet: **SUCCESS** (contract `CC5UPX27ZTQI52S3IWNSQPE2HSL4Z3S7EMH6S72NIYVWW6WLY2ICPW5O`,
  VK set at construction).
- Single on-chain `verify_proof` on testnet: **FAIL** -
  `HostError: Error(Budget, ExceededLimit)`.

### Verdict: GREEN - on-chain verification IS feasible on testnet. Verifier choice is the deciding factor.

A single UltraHonk verification fits inside Soroban's per-transaction budget on the public
testnet - WHEN using an optimized verifier. The deciding variable is the verifier
implementation, not Stellar's limits.

| Verifier | Result on testnet |
|----------|-------------------|
| indextree/ultrahonk_soroban_contract (`ultrahonk_rust_verifier` rev 2a73c4ba) | FAIL - `Budget/ExceededLimit` at simulation |
| **NethermindEth/rs-soroban-ultrahonk** (`crates/ultrahonk-soroban-verifier`) | **PASS - verified + submitted on testnet** |

Nethermind run (commit 661db07, same nargo 1.0.0-beta.9 / bb 0.87.0):
- Deployed: `CAXLUR57WF67ACRMIS2W5TJWU3J6KFOSHV2BN443CU2NIGLLJIRULIFX`
- Proof 14592 bytes, public_inputs 32 bytes (their default/tornado circuit)
- `verify_proof` simulated (passed budget) AND submitted: tx
  `e9a8261b0793c34a8c58c725e7ab40a212afca82ac456e60d1e7c248c826fb5f`
- "Proof successfully verified on-chain!"

So the earlier RED was an artifact of testing the LESS-optimized indextree verifier first.
Use Nethermind's verifier crate. The foundation holds; the SDF / native-pairing dependency
is NOT a blocker.

### OUR circuit on testnet (confirmed 2026-06-16) - PASS

Deployed Nethermind verifier bound to OUR `circuits/spend` VK:
`CAU63XJSNFZXFYDTNRLBOF3QFNUNKXPM5EXWCK36FFF5UOMVU65V67JA`
- Valid proof (967-gate spend circuit, 3 public inputs / 96 bytes): **accepted + submitted**,
  tx `4d11eb55555c06a2efa74af29e51cdf79260719a05b8574aa51ef743e02fcddb`.
- Corrupted proof: **rejected** at simulation, `HostError: Error(Contract, #4)` (verifier's
  invalid-proof error) - never submits. So it is genuinely verifying.

Our artifacts were format-compatible with no rebuild: Nethermind's `build_all.sh` uses the
identical `--scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields`.

### Cost measured (2026-06-16, our spend circuit, Nethermind verifier)

| Metric | Value |
|--------|-------|
| CPU instructions (one verify) | **79,922,355 = 79.92% of the ~100M per-tx limit** |
| Ledger read/write bytes | 0 (pure compute; the real settlement contract adds storage I/O) |
| Min resource fee | 137,525 stroops (~0.0138 XLM); actual charged ~122,888 (~0.0123 XLM) |
| Tx envelope size | 15,052 bytes (proof 14,592 + pubs 96 + overhead) |

### CRITICAL implication: the locked two-verify settlement does NOT fit

One verify is ~80% of the budget. The settlement design we locked in the eng review
(per-side proofs: verify BOTH maker and taker proofs in one atomic tx) needs ~2x ~= 160M
instructions, which is ~160% of the limit. **Two verifies in one transaction is infeasible.**
This forces a settlement-architecture change. Options to evaluate (M1 design):
1. **Recursive aggregation** - combine the two spend proofs into ONE proof, verify once.
   (Check feasibility: recursive UltraHonk verification on Soroban may be contract-size limited.)
2. **Split settlement across two txs** - verify each side separately; recover atomicity with an
   escrow/commit-reveal pattern. Loses single-tx atomicity; needs careful design.
3. A cheaper verification scheme, or batched/folding schemes.

Also note: even a SINGLE verify leaves only ~20% headroom, so adding the settlement contract's
own storage I/O (nullifier checks, tree/root writes) on top of one verify must be measured -
it may not fit alongside a verify either.

### Resolved: the cost lever is native BN254 host functions (Protocol 25)

Chased the salazarsebas/stellar-zk "~35M" claim. Findings:
- Stellar **Protocol 25 introduced native BN254 host functions** (`g1_add`, `g1_mul`,
  `g1_neg`, `fr_from_bytes`, `pairing_check`). A verifier that offloads pairing/MSM to these
  is far cheaper than one doing BN254 in WASM. (Our testnet is Protocol 26 -> available.)
- Our measured **79.9M uses Nethermind's verifier, which does BN254 in pure WASM via arkworks
  `ark-bn254`** - it does NOT use the native host functions. That is the ~2.3x penalty.
- salazarsebas's **"~35M" is a STATIC COST-MODEL ESTIMATE**, not a measurement. Its
  `stellar-zk-ultrahonk` crate is an OFF-CHAIN proving/estimator backend (no on-chain verifier
  contract, no `pairing_check` calls; `estimate_cost()` -> `static_estimate()`). Their real,
  demonstrated native-path number is **Groth16 ~12M**.

Three paths (cost vs trusted-setup):
| Path | Per-verify | 2-in-1-tx | Status |
|------|-----------|-----------|--------|
| UltraHonk, software BN254 (Nethermind) | 79.9M measured | no | works today; needs settlement redesign |
| UltraHonk, native BN254 host fns | ~35M modeled | yes (~70M) | NOT built/measured; needs verifier port |
| Groth16, native BN254 host fns | ~12M (their real #) | yes (~24M) | proven path; needs per-circuit TRUSTED SETUP |

Open decision for M1: build/port a native-host-function UltraHonk verifier (~35M target, no
trusted setup, unproven) vs adopt Groth16 (~12M proven, trusted setup). Only EC ops offload to
host fns; sumcheck/field work stays in WASM, so ~35M is plausible but must be measured.
```
