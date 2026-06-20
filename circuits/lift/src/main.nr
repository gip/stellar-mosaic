// lift_order circuit - production replacement for the Milestone 0 spike (circuits/spend).
//
// Consumes one active asset note and authorizes creating one active order note.
// See docs/lift-circuit-spec.md for the full public-input vector, the v1
// "full consumption, no change at lift" decision, and the contract obligations
// that make the whole thing sound. See docs/note-types.md for the notes.
//
// What this proves (the contract trusts these because the proof verifies):
//   (1) the owner knows sk_o behind the consumed note's owner_tag
//   (2) the consumed asset note is in the tree at `root` (membership hides WHICH note)
//   (3) `nullifier_in` is the correct nullifier for that note (double-spend guard)
//   (4) `order_leaf` is exactly H(the public order fields) - so the contract can
//       insert it without paying Poseidon, and settle/cancel can trust the fields
//   (5) the proof is domain-separated to `lift` (not replayable as unshield/cancel)
//
// Unlike the spike, `root` and `nullifier_in` are public INPUTS asserted against
// witness-derived values (the spike returned them as outputs, which any witness
// satisfied - fine only for sizing).
//
// beta.9 note: stdlib `Poseidon2` is private; the public primitive is
// `std::hash::poseidon2_permutation`. We build a 2-to-1 compression from it and
// fold left-to-right for multi-input hashes. The contract and wallet MUST use the
// identical convention or leaves/nullifiers will not match.

// Production tree depth. M0's verify cost (79.9M CPU) was measured at depth 5;
// this MUST be re-measured on testnet at this depth before the budget is trusted.
// depth 32 ~= 4.3B notes. Tune deliberately against the measured cost.
global TREE_DEPTH: u32 = 32;

// Domain separator for lift proofs. Distinct constants for unshield/cancel keep
// same-shape proofs from being replayed across operations.
global LIFT_DOMAIN: Field = 1;

// 2-to-1 Poseidon2 compression (width-4 permutation, take the first lane).
fn compress(a: Field, b: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, 0, 0], 4)[0]
}

// Left-to-right fold of n>=2 inputs: H(a,b,c,...) = compress(...compress(compress(a,b),c)...).
fn hash3(a: Field, b: Field, c: Field) -> Field {
    compress(compress(a, b), c)
}

fn hash8(
    a: Field,
    b: Field,
    c: Field,
    d: Field,
    e: Field,
    f: Field,
    g: Field,
    h: Field,
) -> Field {
    let mut acc = compress(a, b);
    acc = compress(acc, c);
    acc = compress(acc, d);
    acc = compress(acc, e);
    acc = compress(acc, f);
    acc = compress(acc, g);
    compress(acc, h)
}

fn main(
    // --- private witness ---
    rho_in: Field,                  // consumed note randomness
    sk_o: Field,                    // owner secret
    path: [Field; TREE_DEPTH],      // Merkle sibling path
    index_bits: [Field; TREE_DEPTH],// path direction bits (boolean-constrained)
    // --- public inputs (positional; see docs/lift-circuit-spec.md) ---
    domain: pub Field,              // [0] must equal LIFT_DOMAIN
    root: pub Field,                // [1] membership root (contract: root-history ring)
    nullifier_in: pub Field,        // [2] consumed-note nullifier (contract: unused -> record)
    asset_in: pub Field,            // [3] offered asset == consumed note asset
    amount_in: pub Field,           // [4] offered amount == consumed note amount (full consumption)
    asset_out: pub Field,           // [5] wanted asset
    min_out: pub Field,             // [6] limit terms, scaled integer
    output_owner_tag: pub Field,    // [7] proceeds destination tag
    cancel_owner_tag: pub Field,    // [8] cancel-authority tag
    expiry: pub Field,              // [9] order validity deadline (unix seconds; book rejects when past)
    partial_allowed: pub Field,     // [10] 0/1: may this order be partially filled in the book
    order_leaf: pub Field,          // [11] leaf binding every order field the book/cancel trust
) {
    // (5) domain separation: this proof is only valid as a lift.
    assert(domain == LIFT_DOMAIN);

    // (1) ownership: reconstruct the consumed note's owner_tag from secrets.
    let pk_o = compress(sk_o, 0);
    let owner_tag_in = compress(pk_o, rho_in);

    // consumed asset note leaf = H(asset, amount, owner_tag). amount_in is the
    // full note amount (v1: no change at lift), so the offered amount IS this leaf's.
    let input_leaf = hash3(asset_in, amount_in, owner_tag_in);

    // (2) membership: fold the input leaf up the path to a root, assert it matches.
    let mut node = input_leaf;
    for i in 0..TREE_DEPTH {
        let bit = index_bits[i];
        assert(bit * (bit - 1) == 0); // each index bit must be boolean
        let sib = path[i];
        let left = (1 - bit) * node + bit * sib;
        let right = (1 - bit) * sib + bit * node;
        node = compress(left, right);
    }
    assert(node == root);

    // (3) nullifier correctness for the consumed note.
    assert(compress(sk_o, rho_in) == nullifier_in);

    // partial_allowed is a boolean flag the book trusts; constrain it so a proof cannot bind a
    // non-{0,1} value that the contract would misread.
    assert(partial_allowed * (partial_allowed - 1) == 0);

    // (4) order leaf binds every field the book/cancel will trust, now including the validity
    // deadline and the partial-execution flag.
    let computed_order_leaf = hash8(
        asset_in,
        amount_in,
        asset_out,
        min_out,
        output_owner_tag,
        cancel_owner_tag,
        expiry,
        partial_allowed,
    );
    assert(computed_order_leaf == order_leaf);
}
