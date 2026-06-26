// Wallet helper: 2-to-1 Poseidon2 compression, the single primitive the note tree is built from.
// Executed in-browser / in-Node via noir_js (NOT proved) so the SDK can rebuild Merkle membership
// paths off-chain. This is the EXACT convention used by circuits/lift, circuits/unshield,
// circuits/wallet/note_tag, the on-chain contract's Hasher::compress, and the Rust indexer's
// NoteTree::compress (tools/indexer/src/lib.rs), so values are byte-identical by construction:
//
//   compress(a, b) = poseidon2_permutation([a, b, 0, 0], 4)[0]

fn compress(a: Field, b: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, 0, 0], 4)[0]
}

fn main(a: Field, b: Field) -> pub Field {
    compress(a, b)
}
