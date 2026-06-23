// lift_order circuit (WS4) - the order-PLACEMENT proof.
//
// Consumes one active asset note and authorizes resting one order in the on-chain order-commitment
// tree. Unlike WS1 (where `settle` crossed two lift proofs in the clear), matching now happens in a
// separate `match` circuit; lift only proves a sound placement.
//
// What this proves (the contract trusts these because the proof verifies):
//   (1) the owner knows sk_o behind the consumed note's tag
//   (2) the consumed asset note is in the note tree at `note_root` (membership hides WHICH note)
//   (3) `nullifier_in` is the correct note-spend nullifier for that note, AND inserting it advances
//       the nullifier IMT from `nullifier_root_in` to `nullifier_root_out` (non-membership proven
//       in-circuit; the contract just CAS-checks the root and stores the new one - no on-chain hash)
//   (4) `order_leaf` is exactly H8(the public order fields), so the contract appends it to the order
//       tree without paying Poseidon over the fields and the match/cancel circuits can trust them
//   (5) the proof is domain-separated to `lift`
//
// Per-note nonce: the consumed note's tag/nullifier fold in a public `nonce_in` (see mosaic lib),
// so a note minted by an incremental fill is uniquely spendable.

use mosaic::{
    asset_note_leaf, fold_root, hash8, imt_insert, ImtLeaf, note_nullifier, note_owner_tag,
    output_owner_tag, pk_from_sk, TREE_DEPTH,
};

global LIFT_DOMAIN: Field = 1;

fn main(
    // --- private witness: consumed note ---
    rho_in: Field, // consumed note randomness (its order's rho_out, or the shield rho)
    sk_o: Field, // owner secret
    nonce_in: Field, // consumed note's mint nonce (0 for a plain shield; match nonce for a fill)
    path: [Field; TREE_DEPTH], // note-tree sibling path
    index_bits: [Field; TREE_DEPTH], // note-tree path direction bits
    // --- private witness: nullifier IMT transition (insert nullifier_in) ---
    low_value: Field,
    low_next_value: Field,
    low_next_index: Field,
    low_path: [Field; TREE_DEPTH],
    low_index_bits: [Field; TREE_DEPTH],
    new_path: [Field; TREE_DEPTH],
    new_index_bits: [Field; TREE_DEPTH],
    // --- public inputs (positional; byte offsets must match the contract's `place_order`) ---
    domain: pub Field, // [0]  must equal LIFT_DOMAIN
    note_root: pub Field, // [1]  consumed-note membership root (contract: root history)
    nullifier_root_in: pub Field, // [2]  nullifier IMT root before this spend (contract: == current)
    nullifier_root_out: pub Field, // [3]  nullifier IMT root after (contract: advance to this)
    nullifier_in: pub Field, // [4]  consumed-note nullifier (the value inserted into the IMT)
    asset_in: pub Field, // [5]  offered asset == consumed note asset
    amount_in: pub Field, // [6]  offered amount == consumed note amount (full consumption)
    asset_out: pub Field, // [7]  wanted asset
    min_out: pub Field, // [8]  limit terms, scaled integer
    output_owner_tag_pub: pub Field, // [9]  proceeds destination base tag (match folds the note nonce)
    cancel_owner_tag: pub Field, // [10] cancel-authority tag
    expiry: pub Field, // [11] order validity deadline (unix seconds)
    partial_allowed: pub Field, // [12] 0/1: may this order be partially filled
    order_leaf: pub Field, // [13] H8 binding every order field the book/match/cancel trust
) {
    // (5) domain separation.
    assert(domain == LIFT_DOMAIN);

    // (1) ownership + (2) membership of the consumed note, with the per-note nonce folded in.
    let pk_o = pk_from_sk(sk_o);
    let base_tag = output_owner_tag(pk_o, rho_in);
    let tag_in = note_owner_tag(base_tag, nonce_in);
    let input_leaf = asset_note_leaf(asset_in, amount_in, tag_in);
    assert(fold_root(input_leaf, path, index_bits) == note_root);

    // (3) nullifier correctness, then prove the IMT transition that consumes it.
    let nf = note_nullifier(sk_o, rho_in, nonce_in);
    assert(nf == nullifier_in);
    let low = ImtLeaf { value: low_value, next_value: low_next_value, next_index: low_next_index };
    let root_out = imt_insert(
        nullifier_root_in,
        nf,
        low,
        low_path,
        low_index_bits,
        new_path,
        new_index_bits,
    );
    assert(root_out == nullifier_root_out);

    // partial_allowed is a boolean the book trusts.
    assert(partial_allowed * (partial_allowed - 1) == 0);

    // (4) order leaf binds every field the book/match/cancel will trust.
    let computed_order_leaf = hash8(
        asset_in,
        amount_in,
        asset_out,
        min_out,
        output_owner_tag_pub,
        cancel_owner_tag,
        expiry,
        partial_allowed,
    );
    assert(computed_order_leaf == order_leaf);
}
