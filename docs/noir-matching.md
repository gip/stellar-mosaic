# Design: order-book matching in Noir (WS4)

Design document for moving from the **simplistic on-chain order book** to an **off-chain book whose
matching runs in Noir and is verified on-chain** — and, as the enabling step, moving orders and
nullifiers from flat per-key storage into **merkle trees**.

Read `simple-order-book.md` for what exists today and `architecture.md` for the settlement shape.

## Where we are today

The contract stores book and spend state as flat Soroban entries (`contracts/settlement/src/lib.rs`):

- **Nullifiers:** one persistent key per spend, `DataKey::Nullifier(BytesN<32>)` — an **unbounded
  set**. This is the only unbounded rent surface in the protocol.
- **Orders:** `DataKey::Book(pair_id, side) -> Vec<OrderEntry>` (≤64), read-modify-written every op.
- **Roots:** `DataKey::Root(BytesN<32>)` — an unbounded set of accepted tree roots.

Matching itself happens in plaintext: `settle` crosses two verified order proofs in the clear, and
`submit_order` walks the sorted `Vec` and fills. The proof authorizes the *spend*; the *match* is
trusted contract logic. That caps book depth at 64/side and makes each fill pay depth-32 Poseidon
inserts (see `benchmarks.md`).

## WS4.1 — orders and nullifiers in a merkle tree (the enabling step)

**Nullifiers → an indexed merkle tree (accumulator).** Replace the per-spend key set with a single
accumulator root and prove **non-membership in-circuit** at spend time. An *indexed* merkle tree
(each leaf stores `{value, next_value, next_index}`, à la Aztec/Tornado-Nova) lets a spend prove "my
nullifier is not yet in the set" with one low-leaf membership proof, then insert it. Effect: live
state for nullifiers collapses from O(spends) to **O(1)** (one root + a small append structure),
removing the unbounded rent surface flagged in `implementation.md`.

**Orders → a commitment tree.** Move resting orders out of the monolithic `Vec` into an append-only
order-commitment tree keyed per pair/side, with cancellation handled by a nullifier (already the
model — `cancel_order` proves knowledge of `cancel_owner_tag`). This unbounds depth beyond 64, makes
a fill touch only the entries it consumes (vs. re-serializing the whole side), and lets resting
*orders* gain the same owner-anonymity the note tree already gives *balances*.

Both reuse the contract's existing on-chain Poseidon2 `compress` (byte-identical to the circuits), so
the indexer (`tools/indexer`) extends to these trees with no new hash.

## WS4.2 — matching in Noir, verified on-chain

With orders and nullifiers in trees, the matcher becomes a **prover**: an off-chain matcher selects
crossing orders and produces a Noir proof that the match is valid against the public order-tree root,
which the contract verifies in one shot instead of re-deriving the cross itself.

Proposed matching-circuit public interface (sketch):

```
public:  order_root         // root the matched orders are members of
         nullifier_root_in  // accumulator before this match
         nullifier_root_out // accumulator after consuming the matched orders' spend-nullifiers
         proceeds[]         // (asset, amount, output_owner_tag) leaves to mint
private: matched orders + their membership paths
         the lot decomposition (exact-ratio lots; see simple-order-book.md)
assert:  each order is a member of order_root
         prices cross (U256 cross-multiplication, in-circuit)
         conservation: proceeds + returns == amounts consumed
         nullifier_root_out = insert(nullifier_root_in, spend nullifiers)
```

The contract then: verifies the proof (~80M, fixed), checks `nullifier_root_in` is current, advances
to `nullifier_root_out`, and mints `proceeds`. Matching trust moves from contract code to a verified
circuit, and a single proof can settle a multi-order sweep that today costs many on-chain inserts.

## Why this is WS4, not WS1

It is a strictly harder, optional evolution: the v1 plaintext book already settles soundly and fits
the budget. WS4 buys **unbounded depth, O(1) nullifier state, resting-order privacy, and cheaper deep
sweeps** — at the cost of a matching circuit and the tree migrations. Sequencing: WS4.1 (trees) first,
because the matching circuit proves against those roots.

## Open questions

- Indexed-merkle-tree vs. sparse-merkle-tree for the nullifier accumulator (insert cost vs. proof
  size on Soroban).
- Who runs the matcher, and the MEV/ordering threat model once matching is a single submitted proof.
- Migration: dual-write the `Vec` book and the order tree during rollout, or a hard cutover.
