// unshield circuit (WS4) - spend an asset note and authorize transferring the real token out.
//
// Same ownership/membership machinery as circuits/lift, but it creates no order: it proves the
// spender owns an asset note in the tree, consumes its note-spend nullifier into the IMT, and binds
// the public withdrawal terms (asset, amount) plus a RECIPIENT so a relayer cannot redirect funds.
//
// Public inputs (positional; order matches the contract's `unshield`):
//   [0] domain              must equal UNSHIELD_DOMAIN (distinct from lift, so not cross-usable)
//   [1] note_root           consumed-note membership root (contract checks the published history)
//   [2] nullifier_root_in   nullifier IMT root before this spend (contract: == current)
//   [3] nullifier_root_out  nullifier IMT root after (contract: advance to this)
//   [4] nullifier           spent note's nullifier (the value inserted into the IMT)
//   [5] asset               asset id withdrawn (contract transfers exactly this token)
//   [6] amount              amount withdrawn
//   [7] recipient           binds the destination (contract recomputes sha256(address))

use mosaic::{
    asset_note_leaf, fold_root, imt_insert, ImtLeaf, note_nullifier, note_owner_tag,
    output_owner_tag, pk_from_sk, TREE_DEPTH,
};

global UNSHIELD_DOMAIN: Field = 2;

fn main(
    // --- private witness: consumed note ---
    rho_in: Field,
    sk_o: Field,
    nonce_in: Field,
    path: [Field; TREE_DEPTH],
    index_bits: [Field; TREE_DEPTH],
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
    note_root: pub Field,
    nullifier_root_in: pub Field,
    nullifier_root_out: pub Field,
    nullifier: pub Field,
    asset: pub Field,
    amount: pub Field,
    recipient: pub Field,
) {
    // domain separation.
    assert(domain == UNSHIELD_DOMAIN);

    // ownership + membership of the spent note, with the per-note nonce folded in.
    let pk_o = pk_from_sk(sk_o);
    let tag = note_owner_tag(output_owner_tag(pk_o, rho_in), nonce_in);
    let leaf = asset_note_leaf(asset, amount, tag);
    assert(fold_root(leaf, path, index_bits) == note_root);

    // nullifier correctness, then the IMT transition that consumes it.
    let nf = note_nullifier(sk_o, rho_in, nonce_in);
    assert(nf == nullifier);
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

    // bind the recipient so the proof commits to exactly one payout destination.
    let bound = mosaic::compress(nullifier, recipient);
    assert(bound != 0);
}
