// Milestone 0 - representative spend circuit (SIZING SPIKE, not the final scheme).
//
// Shape mirrors the planned private-DEX spend so the proof size and on-chain
// verification cost are realistic:
//   (1) commitment      C = H(asset, amount, owner_pk, serial, blind)
//   (2) Merkle membership: fold C up a depth-5 path to a root
//   (3) authorization   owner_pk = H(sk)        (hash-lock: must know sk)
//   (4) nullifier       N = H(serial, nk)
//   (5) txbind binding  bind the proof to its settlement
//
// beta.9 note: stdlib `Poseidon2` is private; the public primitive is
// `std::hash::poseidon2_permutation`. We build a 2-to-1 compression from it.
//
// SIMPLIFICATION FOR THE SPIKE: root + nullifier are returned as public OUTPUTS
// (computed in-circuit) so any witness satisfies the circuit. In the real
// circuit they become public INPUTS asserted against on-chain state. The
// constraint cost (the hashes) is unchanged, so the size/gas measurement holds.

global TREE_DEPTH: u32 = 5;

// 2-to-1 Poseidon2 compression (width-4 permutation, take the first lane).
fn compress(a: Field, b: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, 0, 0], 4)[0]
}

fn main(
    // --- private witness (the note + the owner's secrets) ---
    asset: Field,
    amount: Field,
    serial: Field,
    blind: Field,
    sk: Field,
    nk: Field,
    path: [Field; TREE_DEPTH],
    index_bits: [Field; TREE_DEPTH],
    // --- public input ---
    txbind: pub Field,
) -> pub (Field, Field) {
    // (3) authorization: owner_pk = H(sk). Spending requires knowing sk.
    let owner_pk = compress(sk, 0);

    // (1) commitment = absorb(asset, amount, owner_pk, serial, blind)
    let mut acc = compress(asset, amount);
    acc = compress(acc, owner_pk);
    acc = compress(acc, serial);
    let commitment = compress(acc, blind);

    // (2) Merkle membership: fold the commitment up the path to the root.
    let mut node = commitment;
    for i in 0..TREE_DEPTH {
        let bit = index_bits[i];
        assert(bit * (bit - 1) == 0); // each index bit must be boolean
        let sib = path[i];
        let left = (1 - bit) * node + bit * sib;
        let right = (1 - bit) * sib + bit * node;
        node = compress(left, right);
    }
    let root = node;

    // (4) nullifier
    let nullifier = compress(serial, nk);

    // (5) bind the proof to this settlement (txbind). Constrained so the proof
    //     commits to txbind. Real circuit exposes this tag for the contract.
    let bind_tag = compress(owner_pk, txbind);
    assert(bind_tag != 0);

    (root, nullifier)
}
