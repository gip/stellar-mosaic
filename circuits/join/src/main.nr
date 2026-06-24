// join circuit (WS4) - consolidate two asset notes of the same asset into two fresh asset notes
// (target + change), without unshielding. The second input is OPTIONAL: a null padding note
// (amount_2 == 0) turns this into a 1->2 SPLIT. See docs/note-types.md.
//
// What this proves (the contract trusts these because the proof verifies):
//   (1) the spender knows the secret behind EACH consumed note's tag (per-note sk)
//   (2) both consumed asset notes are in the note tree at `note_root` (membership hides which)
//   (3) `nullifier_1`/`nullifier_2` are the correct note-spend nullifiers, AND consuming them
//       advances the nullifier IMT from `nullifier_root_in` to `nullifier_root_out` (the second
//       insert is gated on the second input being real; a null note inserts nothing and pins
//       `nullifier_2 == 0`)
//   (4) all amounts fit a bounded bit size, so conservation cannot be forged by field-wrapping
//   (5) value is conserved: amount_1 + amount_2 == out_amount_1 + out_amount_2 (one asset)
//   (6) the proof is domain-separated to `join`
//
// Output notes' tags are wallet-chosen opaque tags (already in note_owner_tag(base, nonce) form so
// they are later spendable); the circuit only binds them so the contract mints exactly those leaves.

use mosaic::{
    asset_note_leaf, fold_root, imt_insert, imt_insert_opt, ImtLeaf, note_nullifier,
    note_owner_tag, output_owner_tag, pk_from_sk, TREE_DEPTH,
};

global JOIN_DOMAIN: Field = 4;

// Max bit size for every amount (two inputs each < 2^124 cannot overflow BN254 in their sum).
global AMOUNT_BITS: u32 = 124;

fn main(
    // --- private witness: input note 1 ---
    sk_1: Field,
    rho_1: Field,
    nonce_1: Field,
    amount_1: Field,
    path_1: [Field; TREE_DEPTH],
    index_bits_1: [Field; TREE_DEPTH],
    // IMT transition for nullifier_1
    low1_value: Field,
    low1_next_value: Field,
    low1_next_index: Field,
    low1_path: [Field; TREE_DEPTH],
    low1_index_bits: [Field; TREE_DEPTH],
    new1_path: [Field; TREE_DEPTH],
    new1_index_bits: [Field; TREE_DEPTH],
    pred1_leaf: Field, // leaf at new1_index-1 (append-frontier proof)
    pred1_path: [Field; TREE_DEPTH],
    pred1_index_bits: [Field; TREE_DEPTH],
    // --- private witness: input note 2 (optional; amount_2 == 0 => null padding) ---
    sk_2: Field,
    rho_2: Field,
    nonce_2: Field,
    amount_2: Field,
    path_2: [Field; TREE_DEPTH],
    index_bits_2: [Field; TREE_DEPTH],
    // IMT transition for nullifier_2 (gated on the note being real)
    low2_value: Field,
    low2_next_value: Field,
    low2_next_index: Field,
    low2_path: [Field; TREE_DEPTH],
    low2_index_bits: [Field; TREE_DEPTH],
    new2_path: [Field; TREE_DEPTH],
    new2_index_bits: [Field; TREE_DEPTH],
    pred2_leaf: Field, // leaf at new2_index-1 (append-frontier proof; gated on real_2)
    pred2_path: [Field; TREE_DEPTH],
    pred2_index_bits: [Field; TREE_DEPTH],
    // --- public inputs (positional; byte offsets must match the contract's `join`) ---
    domain: pub Field, // [0]  must equal JOIN_DOMAIN
    note_root: pub Field, // [1]  membership root
    nullifier_root_in: pub Field, // [2]  nullifier IMT root before
    nullifier_root_out: pub Field, // [3]  nullifier IMT root after
    nullifier_1: pub Field, // [4]  input note 1 nullifier
    nullifier_2: pub Field, // [5]  input note 2 nullifier (0 when the second input is null)
    asset: pub Field, // [6]  the single asset of both inputs and both outputs
    out_tag_1: pub Field, // [7]  target output note destination tag
    out_amount_1: pub Field, // [8]  target output note amount
    out_tag_2: pub Field, // [9]  change output note destination tag
    out_amount_2: pub Field, // [10] change output note amount
) {
    // (6) domain separation.
    assert(domain == JOIN_DOMAIN);

    let real_2 = amount_2 != 0;

    // (1)+(2) ownership + membership, with the per-note nonce folded in.
    let tag_1 = note_owner_tag(output_owner_tag(pk_from_sk(sk_1), rho_1), nonce_1);
    let tag_2 = note_owner_tag(output_owner_tag(pk_from_sk(sk_2), rho_2), nonce_2);
    assert(fold_root(asset_note_leaf(asset, amount_1, tag_1), path_1, index_bits_1) == note_root);
    let root_2 = fold_root(asset_note_leaf(asset, amount_2, tag_2), path_2, index_bits_2);
    assert((real_2 as Field) * (root_2 - note_root) == 0);

    // (3) nullifier correctness + IMT transition. Note 1 always inserts; note 2 only if real,
    // and a null note pins nullifier_2 == 0 so the indexer knows not to insert it.
    let nf_1 = note_nullifier(sk_1, rho_1, nonce_1);
    assert(nf_1 == nullifier_1);
    let nf_2 = note_nullifier(sk_2, rho_2, nonce_2);
    assert((real_2 as Field) * (nf_2 - nullifier_2) == 0);
    assert((1 - real_2 as Field) * nullifier_2 == 0);

    let low1 =
        ImtLeaf { value: low1_value, next_value: low1_next_value, next_index: low1_next_index };
    let mid = imt_insert(
        nullifier_root_in,
        nf_1,
        low1,
        low1_path,
        low1_index_bits,
        new1_path,
        new1_index_bits,
        pred1_leaf,
        pred1_path,
        pred1_index_bits,
    );
    let low2 =
        ImtLeaf { value: low2_value, next_value: low2_next_value, next_index: low2_next_index };
    let root_out = imt_insert_opt(
        real_2,
        mid,
        nf_2,
        low2,
        low2_path,
        low2_index_bits,
        new2_path,
        new2_index_bits,
        pred2_leaf,
        pred2_path,
        pred2_index_bits,
    );
    assert(root_out == nullifier_root_out);

    // (4) bound every amount so conservation cannot be satisfied by wrapping the field.
    amount_1.assert_max_bit_size::<AMOUNT_BITS>();
    amount_2.assert_max_bit_size::<AMOUNT_BITS>();
    out_amount_1.assert_max_bit_size::<AMOUNT_BITS>();
    out_amount_2.assert_max_bit_size::<AMOUNT_BITS>();

    // (5) value conservation.
    assert(amount_1 + amount_2 == out_amount_1 + out_amount_2);

    // bind the output destination tags so a relayer cannot redirect either output.
    let bound = mosaic::compress(out_tag_1, out_tag_2);
    assert(bound != 0);
}
