# mosaic-indexer — off-chain path server

The settlement contract keeps a depth-32 append-only Merkle note tree on-chain, but stores only the
rightmost *filled subtrees* (enough to insert and advance the root), **not** every leaf. So the
chain has the canonical root, yet nobody can derive a membership path from on-chain state alone.

This crate is that missing piece: a **read-only** indexer that ingests the contract's
`shielded` / `settled` events, replays the exact same leaf insertions into a full-leaf tree, and
serves each note's Merkle path so a wallet can generate an order (`circuits/lift`) or
`circuits/unshield` proof against the **current on-chain root**.

It is *not* a trust anchor — the on-chain root is. The indexer only reconstructs paths; the proof it
enables is verified on-chain against the on-chain root.

## Why it depends on a Soroban host

The leaf/node hash is Poseidon2 (BN254, t=4). The only implementation guaranteed byte-identical to
both the Noir circuits and the contract is the host function
`env.crypto_hazmat().poseidon2_permutation` with the `soroban-poseidon` BN254 t=4 constants. So this
off-chain tool instantiates a local Soroban host (`Env`) purely as a hashing engine and reuses the
contract's exact `compress`. There is deliberately no second, hand-ported Poseidon to drift.

## Library

```rust
use mosaic_indexer::NoteTree;
use soroban_sdk::Env;

let env = Env::default();
let mut tree = NoteTree::new(&env);
tree.ingest_shielded(asset_id, amount, &owner_tag);            // one `shielded` event
tree.ingest_settled(a_out, b_amt, &a_tag, b_out, a_amt, &b_tag); // one `settled` event (2 leaves)

let root = tree.root();           // == the contract's root() after the same inserts
let p = tree.path(leaf_index);    // siblings[32] + index_bits[32], LSB-first (circuit layout)
assert_eq!(tree.circuit_fold(&tree.leaf(leaf_index).unwrap(), &p), root); // path satisfies the circuit
```

## `witness` bin

A scriptable path server / `Prover.toml` helper. It replays a line-based event log on stdin and
prints membership witnesses (it refuses to print a path that does not fold to the current root):

```
shield  <asset:u32> <amount:i128> <owner_tag:hex32>
settled <a_asset_out> <b_amount_in> <a_tag> <b_asset_out> <a_amount_in> <b_tag>
root
path    <leaf_index>
```

Example (reproduces the integration-test fixture root):

```sh
printf 'shield 1 100 <owner_tag_a_hex>\nshield 2 2000 <owner_tag_b_hex>\npath 1\n' \
  | cargo run -q --bin witness
```

Copy the printed `root` / `path` / `index_bits` lines straight into the circuit's `Prover.toml`.
This is what makes `contracts/settlement/tests/fixtures/regen.sh` reproducible.

## Correctness

`cargo test` here checks the hashing against the known Noir/contract values and that paths fold to
roots. The decisive cross-check lives in `contracts/settlement/tests/integration.rs`
(`indexer_reproduces_onchain_root_and_serves_valid_paths`): the indexer's reconstructed root equals
the **on-chain** `root()` *and* the root the committed order/unshield proofs were generated against,
and every indexer-derived path folds back to that root.
