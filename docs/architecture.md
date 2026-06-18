# Architecture: verify-at-lift, settle-cheap

This is the entry-point design document for Stellar Mosaic. See `privacy-model.md` for the privacy
model, `note-types.md` for concrete note structures, and `milestone-0-results.md` for measurement
provenance.

## Current verdict

The v1 design is **owner-anonymous and amount-transparent**:

- Public: note asset/amount, order pair/price/size, matches, fill amounts, and timing.
- Hidden: the owner behind each note/order, the create-to-spend link, and which note a spend consumed.
- Settlement is atomic and proof-free because value conservation is checked in plaintext.
- UltraHonk is kept for spend/lift proofs, with no per-circuit trusted setup.

The privacy claim is "no direct owner/wallet linkage inside the pool," not amount privacy. Amounts
and timing remain followable; standard denominations and delayed unshields are privacy
mitigations, not complete fixes.

## Measured constraint

One complete UltraHonk verify using Nethermind's native-BN254 Soroban verifier costs about
**79.9M CPU instructions**, roughly 80% of the ~100M per-transaction Soroban budget. Two verifies in
one transaction are infeasible.

The design therefore decouples expensive verification from cheap settlement:

```
TX 1: maker lift      verify one spend proof, store active order note
TX 2: taker lift      verify one spend proof, store active order note
TX 3: settle          no proof verify, consume two active order notes atomically
```

Measured settlement-spike shape:

- Real lift with verifier plus store: about **82%** of the per-transaction budget.
- Proof-free settle consuming two lifted entries: about **10-13%** of the budget.

The spike validates cost and transaction shape. It is not final settlement soundness yet: the spike
circuit binds only `[txbind, root, nullifier]`; the production lift circuit must bind every field
settlement later trusts.

Cost/UX reality: a cold two-party trade is multiple transactions, not one monolithic transaction.
Each party shields and lifts separately, then settlement is cheap. LPs can pre-shield and pre-lift
resting orders so the hot path is only the taker's lift plus settle.

## Contracts and state

Use one logical note registry for all active/consumed asset and order notes:

- **Assets/custody contract:** holds real Soroban tokens, maintains the canonical commitment and
  nullifier registry, and handles shield/unshield.
- **Desk contract:** owns order matching and calls the registry to consume/create notes atomically.
  A merged contract is also viable, but separate commitment/nullifier registries are not.

Supported assets are admin-gated. USDC and XLM can be native Stellar/Soroban assets. ETH and XRP
require wrapped issuers or bridge integrations before they can be custodied.

## Flow

1. **Shield**
   - User transfers a supported asset into custody.
   - Contract creates an active `AssetNote { asset, amount, owner_tag }`.
   - Under the public-note model, the contract can compute the leaf directly. A proof may still be
     useful to prove the shielder knows the owner secret, but it is not required for value
     conservation.

2. **Lift order**
   - User spends an active asset note.
   - The lift proof verifies membership, ownership, nullifier correctness, and value conservation.
   - The input asset note is nullified at lift.
   - Contract creates an active order note. The offer is firm, so `cancel`/expiry is required.
   - The proof must bind every order field settlement will use.

3. **Settle**
   - Contract reads two active order notes.
   - It checks asset compatibility, price compatibility, fill amount, and per-asset conservation in
     plaintext.
   - It nullifies both order notes.
   - It creates active proceeds notes and, for partial fills, change notes.
   - No proof is verified in `settle`.

4. **Cancel**
   - User proves authority over an active order note.
   - Contract nullifies the order note and creates an active asset note for the unfilled value.
   - This path is required so firm resting offers do not trap funds.

5. **Unshield**
   - User spends an active asset note with a proof.
   - Contract records the nullifier and transfers the public `asset` and `amount` out.
   - Users hold the note secrets; losing those secrets means losing access unless a later recovery
     design is added.

## Soundness invariants

- **Full binding at lift:** the lift proof must bind the consumed nullifier, input asset/value,
  output order fields, `output_owner_tag`, `cancel_owner_tag`, root, and domain separator.
- **Canonical registry:** asset notes and order notes must share one logical commitment/nullifier
  registry. Separate registries create double-spend risk.
- **Only verified paths create active orders:** no function except the verified lift path may create
  active order state.
- **Settlement constructs outputs:** `settle` computes proceeds and change leaves itself from public
  checked values. It must not accept arbitrary output commitments from a caller.
- **Single-use notes:** every consumed asset or order note records a nullifier before outputs become
  active.
- **Cancel before production:** firm orders require cancellation or expiry.

## Open implementation gaps

- **Final lift circuit:** DRAFTED in `circuits/lift` (spec: `lift-circuit-spec.md`). Binds
  `asset_in`, `amount_in`, `asset_out`, `min_out`, `output_owner_tag`, `cancel_owner_tag`, plus
  membership `root`, `nullifier_in`, and a `lift` domain separator; promotes root/nullifier from
  spike *outputs* to asserted public *inputs*. Compiles and is satisfiable (3,335 gates); tampering
  any bound field fails the constraints. v1 = full consumption, no change at lift. **On-chain verify
  measured on testnet 2026-06-18: 80,641,857 CPU (~80.6% of budget), +0.9% over the depth-5 spend
  spike — fits.** DONE: `contracts/settlement` `lift` now asserts this exact public-input vector
  (domain + published root + nullify-at-lift + every order field derived from the proof), validated
  end-to-end on testnet at ~81.2% of budget. See `milestone-0-results.md`.
- **Cancel design:** define the exact cancel proof, output asset-note construction, and cost.
- **Registry ownership:** choose merged contract vs Assets-owned registry plus Desk cross-contract
  calls; measure cross-contract cost alongside a verify.
- **Asset-note layer:** keep shield -> asset note -> order as the default because one shield can
  back several future orders. Direct shield-to-order can be added later if the UX needs it.
- **Partial fills:** settle should emit two proceeds notes plus up to two change notes for the
  unfilled side(s).
- **Wrapped assets:** define issuers/bridges before advertising ETH/XRP support.
- **Standalone build:** the settlement spike depends on a vendored Nethermind verifier path that is
  gitignored; make it reproducible before treating the spike as a buildable package.
