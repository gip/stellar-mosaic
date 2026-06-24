// cancel circuit (WS4) - reclaim a resting order's locked funds.
//
// In WS4 orders live in the order-commitment tree, so cancel now proves MEMBERSHIP (not a plaintext
// book lookup) and consumes the order via the nullifier IMT, so a cancel and a match race for the
// same order and whichever lands first blocks the other.
//
// What this proves (the contract trusts these because the proof verifies):
//   (1) domain separation to `cancel`
//   (2) the order_leaf = H8(its terms) is a member of an accepted order-tree root
//   (3) the canceller knows the secret behind the order's cancel_owner_tag (authorization)
//   (4) order_nullifier = H(ORDER_NULLIFIER_DOMAIN, order_leaf), and inserting it advances the
//       nullifier IMT from nf_root_in to nf_root_out (one-shot consume)
//   (5) the public asset_in/amount_in are exactly the order's locked asset/amount (bound via the
//       order_leaf), so the contract returns the correct funds
//   (6) the return destination is bound (a relayer cannot redirect the returned note)
//
// Public inputs: [0] domain [1] order_root [2] nf_root_in [3] nf_root_out [4] order_nullifier
//   [5] asset_in [6] amount_in [7] return_owner_tag.

use mosaic::{
    compress, fold_root, imt_insert, ImtLeaf, order_consumption_nullifier,
    order_leaf as build_order_leaf, output_owner_tag, pk_from_sk, TREE_DEPTH,
};

global CANCEL_DOMAIN: Field = 3;

fn main(
    // --- private witness: the order's hidden terms + the canceller's secret ---
    sk_o: Field, // owner secret (cancel authority)
    rho_ord: Field, // cancel randomness: cancel_owner_tag = compress(pk_o, rho_ord)
    asset_out: Field,
    min_out: Field,
    out_owner_tag: Field, // the order's output_owner_tag (opaque here)
    expiry: Field,
    partial_allowed: Field,
    order_path: [Field; TREE_DEPTH],
    order_index_bits: [Field; TREE_DEPTH],
    // --- private witness: nullifier IMT transition ---
    low_value: Field,
    low_next_value: Field,
    low_next_index: Field,
    low_path: [Field; TREE_DEPTH],
    low_index_bits: [Field; TREE_DEPTH],
    new_path: [Field; TREE_DEPTH],
    new_index_bits: [Field; TREE_DEPTH],
    pred_leaf: Field, // leaf at new_index-1 (append-frontier proof)
    pred_path: [Field; TREE_DEPTH],
    pred_index_bits: [Field; TREE_DEPTH],
    // --- public inputs ---
    domain: pub Field,
    order_root: pub Field,
    nullifier_root_in: pub Field,
    nullifier_root_out: pub Field,
    order_nullifier: pub Field,
    asset_in: pub Field,
    amount_in: pub Field,
    return_owner_tag: pub Field,
) {
    // (1) domain separation.
    assert(domain == CANCEL_DOMAIN);

    // (3) authorization: reconstruct the order's cancel_owner_tag from the canceller's secret.
    let cancel_owner_tag = output_owner_tag(pk_from_sk(sk_o), rho_ord);

    // (2)+(5) rebuild the order leaf from the public locked terms + private remaining terms, and
    // prove it is a member of the accepted order root.
    let leaf = build_order_leaf(
        asset_in,
        amount_in,
        asset_out,
        min_out,
        out_owner_tag,
        cancel_owner_tag,
        expiry,
        partial_allowed,
    );
    assert(fold_root(leaf, order_path, order_index_bits) == order_root);

    // (4) consumption nullifier from the public order leaf, then the IMT transition.
    let nf = order_consumption_nullifier(leaf);
    assert(nf == order_nullifier);
    let low = ImtLeaf { value: low_value, next_value: low_next_value, next_index: low_next_index };
    let root_out = imt_insert(
        nullifier_root_in,
        nf,
        low,
        low_path,
        low_index_bits,
        new_path,
        new_index_bits,
        pred_leaf,
        pred_path,
        pred_index_bits,
    );
    assert(root_out == nullifier_root_out);

    // (6) bind the return destination so a relayer cannot redirect the returned funds.
    assert(compress(order_nullifier, return_owner_tag) != 0);
}
