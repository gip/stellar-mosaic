# Lift circuit spec: public-input vector and bindings

This is the production replacement for the Milestone 0 sizing spike (`circuits/spend`). It defines
exactly what the `lift_order` proof binds, what the contract reads, and the soundness obligations on
both sides. Read `note-types.md` for the note structures and `architecture.md` for where lift sits in
the flow.

## What lift does

`lift_order` consumes one active **asset note** and creates one active **order note**:

```
AssetNote { asset_in, amount_in, owner_tag_in }   --consume-->   OrderNote { asset_in, amount_in,
                                                                  asset_out, min_out,
                                                                  output_owner_tag, cancel_owner_tag }
```

The contract cannot check value conservation in plaintext here, because the consumed asset note is
hidden inside the Merkle set (it does not know *which* note was spent). That is the whole reason lift
needs a proof. By contrast `settle` is proof-free: both order notes are already active and public, so
the contract crosses them in the clear.

## v1 decision: full consumption, no change at lift

The input asset note is consumed **in full** into the order's offered side: `amount_in` equals the
consumed note's amount. There is no change note emitted at lift.

Rationale:
- Standard denominations (1/10/100/1000 + change) are already the anonymity-set lever
  (`privacy-model.md`). Users hold exact-denomination notes, so full consumption is the normal case.
- It removes a conservation subtraction and an extra output leaf from the circuit and the contract.
- Splitting a note into a smaller offer is a separate concern (deposit smaller, or a future `split`).

Change still happens at **settle** for partial fills (proceeds + change asset notes), which is
plaintext and proof-free. Change-at-lift is a documented future extension (add a `change_leaf`
public input + `amount_in + change_amount == note_amount`); it is intentionally out of v1.

Consequence to note: because `amount_in` is full-consumption, the order's public `amount_in` equals
the consumed note's amount. This does **not** link the order to a specific note — many notes share
each standard denomination and membership hides which one. The denomination discipline is what makes
this safe; off-denomination amounts shrink the anonymity set (`privacy-model.md`).

## Public input vector

Order matters: the contract reads `public_inputs` positionally, and the verifier binds the proof to
this exact tuple. All are BN254 field elements.

| # | name               | who asserts / uses it | meaning |
|---|--------------------|-----------------------|---------|
| 0 | `domain`           | contract pins to the `lift` constant | domain separator; stops a withdraw/cancel proof of the same shape being replayed as a lift |
| 1 | `root`             | contract: must be in root-history ring | Merkle root the membership proof was made against |
| 2 | `nullifier_in`     | contract: must be unused, then record | nullifier of the consumed asset note |
| 3 | `asset_in`         | contract stores as order field; also = consumed note asset | offered asset |
| 4 | `amount_in`        | contract stores as order field; also = consumed note amount | offered amount (full consumption) |
| 5 | `asset_out`        | contract stores as order field | wanted asset |
| 6 | `min_out`          | contract stores as order field | limit terms, scaled integer (no floats) |
| 7 | `output_owner_tag` | contract stores; `settle` stamps onto proceeds | proceeds destination tag |
| 8 | `cancel_owner_tag` | contract stores; `cancel` checks against | cancel-authority tag |
| 9 | `order_leaf`       | contract inserts into the tree as active order | `H(asset_in, amount_in, asset_out, min_out, output_owner_tag, cancel_owner_tag)` |

`order_leaf` is exposed (rather than recomputed on-chain) so the contract does **not** pay Poseidon
cost to insert the order; it trusts the in-circuit assertion that the leaf equals the hash of the
public fields it stores. Same reasoning as exposing `nullifier_in`.

## Private witness

| name           | meaning |
|----------------|---------|
| `rho_in`       | per-note randomness of the consumed asset note |
| `sk_o`         | owner secret; `pk_o = H(sk_o)`, `owner_tag = H(pk_o, rho_in)` |
| `path[DEPTH]`  | Merkle sibling path for the consumed note |
| `index_bits[DEPTH]` | path direction bits (each constrained boolean) |

`output_owner_tag` and `cancel_owner_tag` are user-chosen public inputs. The circuit binds them into
`order_leaf` but does **not** re-derive them from `sk_o` — a user may legitimately direct proceeds to
any tag. Binding-into-the-leaf is what stops a relayer or the contract from redirecting them.

## In-circuit assertions

1. `pk_o        = H(sk_o)`
2. `owner_tag_in = H(pk_o, rho_in)`
3. `input_leaf  = H(asset_in, amount_in, owner_tag_in)`
4. membership: fold `input_leaf` up `path`/`index_bits`; assert the result `== root`
5. nullifier: assert `H(sk_o, rho_in) == nullifier_in`
6. order leaf: assert `H(asset_in, amount_in, asset_out, min_out, output_owner_tag, cancel_owner_tag)
   == order_leaf`
7. domain: assert `domain == LIFT_DOMAIN` (a circuit constant), so this proof is only valid as a lift

Hashing matches the spike's convention: a 2-to-1 `compress` built from `poseidon2_permutation`
(width 4, first lane), folded left-to-right for multi-input hashes. The contract and wallet MUST use
the identical fold order or leaves/nullifiers will not match. This convention is shared, not final
cryptographic advice; switching to a fixed-arity Poseidon later is fine if circuit and contract move
together.

The Milestone 0 spike exposed `root` and `nullifier` as in-circuit **outputs** (so any witness
satisfied them — fine for a sizing measurement). This circuit promotes them to public **inputs**
asserted against witness-derived values; that promotion is the soundness upgrade the spike flagged.

## Contract obligations (the other half of soundness)

IMPLEMENTED in `contracts/settlement` `lift` and validated on testnet (2026-06-18); see
`milestone-0-results.md`. A proof is necessary but not sufficient. On a verifying `lift` the
contract MUST:

- pin `public_inputs[0] == LIFT_DOMAIN`;
- check `public_inputs[1]` (`root`) is in the root-history ring (tolerate recent roots, reject stale);
- check `public_inputs[2]` (`nullifier_in`) is unused, then record it **before** the order becomes
  active (single-use);
- store the order using fields 3–8 and insert `order_leaf` (field 9) as the active order leaf;
- create active order state **only** on this verified path — no other entry point may mint orders;
- never accept a caller-supplied output commitment; `settle`/`cancel` construct their output leaves
  themselves from checked public values.

## Cost (measured 2026-06-18)

Measured on testnet: this circuit at `TREE_DEPTH=32` verifies in **80,641,857 CPU instructions
(~80.6% of the ~100M budget)** — only **+0.9%** over M0's depth-5 spend spike (79,922,355). Depth and
the extra order-leaf hash barely move verify cost because the UltraHonk proof is padded to
`CONST_PROOF_SIZE_LOG_N=28` regardless of actual circuit size, so verify is dominated by fixed
pairing/MSM, not gate count. Verify-at-lift fits at production depth; two verifies in one tx (~161M)
remain infeasible. Details + contract address in `milestone-0-results.md`. `TREE_DEPTH` stays a
single global, but the measurement shows depth choice is essentially free for verify cost — pick it
for the note-capacity headroom you want (32 ≈ 4B notes).

## Out of scope here (tracked in architecture.md)

- `cancel` circuit (reuses ownership + nullifier machinery; spends `cancel_owner_tag`).
- `withdraw` circuit (asset-note spend, no order created).
- change-at-lift extension.
- registry ownership (merged contract vs Assets-owned registry + Desk cross-calls).
