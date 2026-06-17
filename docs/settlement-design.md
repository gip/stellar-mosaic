# Settlement design: verify-at-lift, settle-cheap

Supersedes the eng-review decision "per-side proofs verified together in one atomic tx."
That decision is overturned by the Milestone 0 cost measurement: one UltraHonk verify =
~79.9M CPU instructions (~80% of the ~100M per-tx Soroban limit), so two verifies in one
transaction (~160M) is infeasible. See `docs/milestone-0-results.md`.

## The model

Decouple verification (expensive, one per tx) from settlement (cheap, must be atomic).

```
  TX 1  maker lift              TX 2  taker lift             TX 3  settle
  ─────────────                 ─────────────                ─────────────
  verify spend proof  ~80M      verify spend proof  ~80M     NO verify
  bind: nullifier, order        bind: nullifier, order       read 2 pool entries
        terms, output commit           terms, output commit  check price compatible
  write pool entry              write pool entry             check + insert 2 nullifiers
  ✅ fits (one verify)          ✅ fits (one verify)         emit 2 output commitments
                                                             move collateral; ATOMIC
                                                             ✅ cheap (pure state ops)
```

A "lift" is posting an offer: verify the spend proof once, then record a validated entry in
the bounded resting-offer pool (N<=32). Matching/settlement consumes pre-verified entries and
does NO proof verification, so it is a cheap state operation. The trade stays atomic because
atomicity now lives in TX 3, which contains nothing expensive.

This is the standard shielded-pool "shield-then-transact" decoupling, and it maps directly
onto the resting-offer pool: verification happens at offer-post time, not at match time.

## Soundness invariants (load-bearing)

1. **The lift proof must bind everything settlement acts on.** Settlement trusts the pool entry
   without re-checking the proof, so the proof's public inputs (or a hash of them) must cover:
   the nullifier, asset in/out, amount, price terms, the output commitment, and the recipient.
   If settlement can act on any field the proof did not commit to, that is a forgery hole.

2. **Pool entries may ONLY be created by the verified `lift` path.** Contract invariant: the
   sole writer of pool state is `lift()`, which verified a proof. Nothing else may write it.

3. **Pool entries are single-use.** Consumed at settlement (marked/removed), bound to their
   nullifier, so no replay.

## Nullifier timing (design choice)

- **Nullify at lift** -> firm offer; needs a `cancel`/reclaim path for unmatched offers (so
  funds are not stuck). Recommended for a DEX (firm quotes, clean UX).
- **Nullify at settlement** -> a note can rest in multiple potential matches; first settlement
  wins, others fail the nullifier check. More flexible but offers are not guaranteed executable.

## Cost

- **Lift tx** = one verify (~79.9M measured, already includes storage writes) + the pool-entry
  write (small). Fits the per-tx budget.
- **Settle tx** = no verify; read 2 entries, check price, check+insert 2 nullifiers, emit 2
  output commitments, move collateral. Pure state ops -> far under budget.
- A trade is 3 txs (2 lifts + 1 settle). Hot-path mitigation: an LP pre-lifts resting offers
  once; only the taker lifts on demand -> 1 lift + 1 settle on the hot path.

## Why this over the alternatives

- vs **recursive aggregation** (fold both proofs into one, verify once): no hard recursion
  engineering; uses the verifier we already proved works.
- vs **Groth16** (~12M, two fit in one tx): no per-circuit trusted setup.

Keeps UltraHonk, no trusted setup, and single-tx-atomic settlement.

## Open items carried forward

- Exact public-input set for the lift proof (invariant 1).
- `cancel`/expiry for unmatched lifted offers (was already an open question: offer lifecycle).
- Measure lift (verify + richer pool-entry write) and settle on testnet (the spike).

## Spike measured on testnet (2026-06-17)

Built `contracts/settlement` (lift + settle), deployed to testnet
(`CDPW6NQHESKBHYERDY5XBPLMEICLM3H6V4ZB7A5F33RXUFEWCJLTYZTS`), ran 2 lifts + 1 settle.
`settle` succeeded and emitted the `settled` event with both output commitments.

Compute cost via non-refundable resource fee (CPU-dominated), vs one UltraHonk verify:

| Operation | Non-refundable fee | vs one verify |
|-----------|--------------------|---------------|
| UltraHonk verify (measured) | 122,698 stroops | 100% (~79.9M CPU) |
| lift (store entry, NO verify) | 6,844 stroops | ~6% |
| settle (consume two, NO verify) | 15,955 stroops | ~13% |

Conclusion (architecture VALIDATED):
- lift tx = verify (~80% budget) + store (~5-6%) -> ~85%, fits.
- settle tx = ~13% of a verify (~10% budget), NO verify -> fits with large margin.
- Two lifts (separate txs) + one settle: each fits individually. Two-sided trade is feasible.

So "verify-at-lift, settle-cheap" fits the Soroban budget where two-verify-in-one-tx did not.

## Real lift measured on testnet (2026-06-17) — full flow

Made `lift` real: it calls Nethermind's verifier (native BN254 host fns) in-process and stores
the entry ONLY if the proof verifies; the stored nullifier is bound to the proof's public inputs.
Contract `contracts/settlement` deployed with our spend-circuit VK
(`CC23Q4KSMUDN5TBXXNSFXTWHTT2U3ZDYNLH3UH65JFKTP2MXEECL346E`).

End-to-end with TWO distinct real proofs:
- lift A (verify proof A + store, id 1): submitted. Non-refundable CPU fee **126,454 stroops**
  (one verify = 122,698; the delta is the pool-entry store). ~**82% of the per-tx budget** -> fits.
- lift with a CORRUPTED proof: **rejected**, `Error(Contract, #8) = VerificationFailed`, nothing
  stored. So lift genuinely verifies before storing.
- lift B (verify proof B + store, id 2): submitted.
- settle(1, 2) (NO verify): submitted; emitted `settled` with both output commitments.
  Non-refundable CPU fee **16,549 stroops** (~13% of a verify, ~10-11% of budget).

Result: a complete two-sided private trade = two verifying lifts (~82% budget each, separate
txs) + one cheap settle (~11% budget). Every tx fits. The architecture is validated end-to-end
on real proofs, not estimates.

Note: the spike circuit binds only [txbind, root, nullifier]; the stored asset/amount/price/
output are NOT yet proof-bound (soundness invariant 1 — the open item). The cost/flow result
is unaffected by that. The settlement contract depends on the vendored Nethermind verifier
(gitignored path), so it does not build standalone yet.
