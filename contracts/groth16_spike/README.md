# groth16_spike — Workstream 3 de-risking spike

**Question:** can a RISC Zero / Boundless receipt (a Groth16 proof over BN254) be verified inside a
Soroban contract within the 400M-instruction per-tx budget, so a Base deposit can mint a note on
Stellar? See `docs/base-bridge.md` plan and the parent `README.md`.

**Answer: yes, and cheaply.** A full Groth16 BN254 verify via the Soroban host's native
`env.crypto().bn254()` (`g1_msm` for the public-input linear combination + a 4-term
`pairing_check`) measured at:

```
groth16 verify CPU: 26,272,369  (~6.6% of the 400M budget)
```

That is cheaper than the native `shield` (~38M) and well under one UltraHonk verify (~80M). Leaves
ample room to run the verify and the note insert (~35M) in a single transaction.

Negative cases reject correctly: a wrong (but valid) public input and a malformed IC length both
return `false`; off-curve points trap (a hostile proof can only revert, never wrongly accept). The
verification equation arrangement — `e(-A,B)·e(alpha,beta)·e(vk_x,gamma)·e(C,delta) == 1` with
`vp1=[-A, alpha, vk_x, C]`, `vp2=[B, beta, gamma, delta]` — is byte-for-byte the arrangement the
official Stellar `groth16_verifier` example uses (that example targets BLS12-381; we use BN254
because RISC Zero / Boundless receipts are over BN254 / alt_bn128, Ethereum's curve).

Run: `cargo test --test spike -- --nocapture` (the test generates a REAL proof with arkworks
off-chain, then verifies it on the Soroban host).

## This is a spike, not the production verifier

The hand-rolled `verify_groth16` here exists only as independent evidence of feasibility + budget.
**Production uses the audited, Soroban-optimized [Nethermind `stellar-risc0-verifier`]
(https://github.com/NethermindEth/stellar-risc0-verifier)** — the same vendor as this repo's
UltraHonk verifier:

- Deployed as a standalone **`RiscZeroVerifierRouter`** contract (routes by the seal's 4-byte
  selector; bundles `Groth16Verifier`, `EmergencyStop`, `TimelockController` governance).
- The settlement contract depends only on the interface crate and cross-calls it:

  ```toml
  risc0-interface = { git = "https://github.com/NethermindEth/stellar-risc0-verifier", package = "risc0-interface" }
  ```

  ```rust
  use risc0_interface::RiscZeroVerifierRouterClient;
  // in shield_from_base, after deriving journal_digest = sha256(journal):
  RiscZeroVerifierRouterClient::new(&env, &router)
      .verify(&seal, &image_id, &journal_digest); // traps on invalid proof
  ```

Using the router means we do **not** hand-roll the RISC Zero receipt specifics (control root,
claim-digest construction, image-id binding, Groth16 params upgrades) — `shield_from_base` only has
to: pin `image_id`, compute `journal_digest`, cross-call `verify`, then parse the journal, check the
Base block commitment against the relayer-attested registry, guard the deposit-id replay set, and
insert the note leaf. The cross-call's verify cost (~the ~26M measured here) is charged to the same
per-tx budget and fits comfortably.
