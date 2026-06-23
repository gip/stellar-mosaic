// Mosaic shared circuit primitives.
//
// Hashing here MUST stay byte-identical to the on-chain contract (host `Hasher`,
// `soroban-poseidon` BN254 t=4) and the indexer. `compress` is the 2-to-1 width-4
// Poseidon2 permutation, first lane; multi-input hashes fold left-to-right. See
// docs/noir-matching.md and the contract's `hash_equivalence` test.

/// Depth of every append-only Merkle tree (note tree, order tree) and the nullifier IMT.
pub global TREE_DEPTH: u32 = 32;

// --- Poseidon2 hashing -------------------------------------------------------

/// 2-to-1 Poseidon2 compression (width-4 permutation, take the first lane).
pub fn compress(a: Field, b: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, 0, 0], 4)[0]
}

/// Left-to-right fold: H(a,b,c) = compress(compress(a,b),c).
pub fn hash3(a: Field, b: Field, c: Field) -> Field {
    compress(compress(a, b), c)
}

/// Left-to-right fold of 8 inputs (the order leaf).
pub fn hash8(
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

// --- Note & nullifier model --------------------------------------------------
//
// Owner identity:    pk_o = compress(sk_o, 0); output_owner_tag = compress(pk_o, rho_out).
// Per-note nonce:    every MINTED note folds a unique public nonce into its tag and
//                    nullifier so an order filling incrementally never collides:
//                      note_owner_tag = compress(output_owner_tag, nonce)
//                      nullifier      = compress(sk_o, compress(rho_out, nonce))
// Asset note leaf:   H3(asset, amount, note_owner_tag).

pub fn pk_from_sk(sk_o: Field) -> Field {
    compress(sk_o, 0)
}

/// Full-field BN254 comparison `a <= b` (beta.9 stdlib exposes only `lt`). `a <= b` iff `!(b < a)`.
pub fn lte(a: Field, b: Field) -> bool {
    !std::field::bn254::lt(b, a)
}

/// The owner-chosen destination tag bound into an order at placement.
pub fn output_owner_tag(pk_o: Field, rho_out: Field) -> Field {
    compress(pk_o, rho_out)
}

/// A minted note's effective owner tag: the order's bound tag folded with the note nonce.
pub fn note_owner_tag(output_owner_tag: Field, nonce: Field) -> Field {
    compress(output_owner_tag, nonce)
}

/// A minted note's nullifier: unique per (owner secret, rho, nonce).
pub fn note_nullifier(sk_o: Field, rho_out: Field, nonce: Field) -> Field {
    compress(sk_o, compress(rho_out, nonce))
}

/// Asset note commitment leaf.
pub fn asset_note_leaf(asset: Field, amount: Field, note_owner_tag: Field) -> Field {
    hash3(asset, amount, note_owner_tag)
}

/// The order leaf binds every order term the book / match / cancel trust.
pub fn order_leaf(
    asset_in: Field,
    amount_in: Field,
    asset_out: Field,
    min_out: Field,
    output_owner_tag: Field,
    cancel_owner_tag: Field,
    expiry: Field,
    partial_allowed: Field,
) -> Field {
    hash8(
        asset_in,
        amount_in,
        asset_out,
        min_out,
        output_owner_tag,
        cancel_owner_tag,
        expiry,
        partial_allowed,
    )
}

/// Domain separator distinguishing order-consumption nullifiers (derived from the PUBLIC order leaf,
/// so a taker who lacks the maker's secret can still consume the order) from secret-derived note-spend
/// nullifiers. An order is matched OR cancelled exactly once: both insert this same value.
pub global ORDER_NULLIFIER_DOMAIN: Field = 7;

pub fn order_consumption_nullifier(order_leaf: Field) -> Field {
    compress(ORDER_NULLIFIER_DOMAIN, order_leaf)
}

// --- Merkle membership -------------------------------------------------------

/// Fold `leaf` up a depth-32 sibling path to the implied root. `index_bits[i] == 0`
/// means the running node is the LEFT child at level i (sibling on the right).
pub fn fold_root(
    leaf: Field,
    path: [Field; TREE_DEPTH],
    index_bits: [Field; TREE_DEPTH],
) -> Field {
    let mut node = leaf;
    for i in 0..TREE_DEPTH {
        let bit = index_bits[i];
        assert(bit * (bit - 1) == 0); // each index bit must be boolean
        let sib = path[i];
        let left = (1 - bit) * node + bit * sib;
        let right = (1 - bit) * sib + bit * node;
        node = compress(left, right);
    }
    node
}

/// Little-endian reconstruction of an index from its boolean bit decomposition.
pub fn bits_to_field(bits: [Field; TREE_DEPTH]) -> Field {
    let mut acc: Field = 0;
    let mut pow: Field = 1;
    for i in 0..TREE_DEPTH {
        assert(bits[i] * (bits[i] - 1) == 0);
        acc += bits[i] * pow;
        pow *= 2;
    }
    acc
}

// --- Indexed Merkle Tree (nullifier accumulator) -----------------------------
//
// Each occupied leaf is a node in a sorted singly-linked list:
//   leaf = H3(value, next_value, next_index).
// The empty set is a single genesis leaf {0,0,0} at index 0 (all other leaves are 0).
// Non-membership of `v` is a "low leaf" L with L.value < v < L.next_value
// (or L.next_value == 0 meaning L is the current maximum).

pub struct ImtLeaf {
    pub value: Field,
    pub next_value: Field,
    pub next_index: Field,
}

impl ImtLeaf {
    pub fn hash(self) -> Field {
        hash3(self.value, self.next_value, self.next_index)
    }
}

/// Prove non-membership of `value` against `root_in`, then insert it. Returns `root_out`.
///
/// Witnesses (supplied by the prover against the real tree):
///   `low`             the predecessor leaf,
///   `low_path/_bits`  its membership path,
///   `new_path/_bits`  the append slot's path (its index encodes `new_index`).
pub fn imt_insert(
    root_in: Field,
    value: Field,
    low: ImtLeaf,
    low_path: [Field; TREE_DEPTH],
    low_index_bits: [Field; TREE_DEPTH],
    new_path: [Field; TREE_DEPTH],
    new_index_bits: [Field; TREE_DEPTH],
) -> Field {
    imt_insert_opt(
        true,
        root_in,
        value,
        low,
        low_path,
        low_index_bits,
        new_path,
        new_index_bits,
    )
}

/// `imt_insert` gated by `enabled`. When `enabled` is false, no constraint is imposed on the
/// witnesses (pass boolean/zero dummies) and `root_in` is returned unchanged - used for optional
/// inserts (e.g. `join`'s padding second note). When true, identical to `imt_insert`.
pub fn imt_insert_opt(
    enabled: bool,
    root_in: Field,
    value: Field,
    low: ImtLeaf,
    low_path: [Field; TREE_DEPTH],
    low_index_bits: [Field; TREE_DEPTH],
    new_path: [Field; TREE_DEPTH],
    new_index_bits: [Field; TREE_DEPTH],
) -> Field {
    let e = enabled as Field;

    // (1) the low leaf is in the current tree (gated).
    assert(e * (fold_root(low.hash(), low_path, low_index_bits) - root_in) == 0);

    // (2) range: low.value < value, and value < low.next_value unless low is the max (gated).
    assert(!enabled | std::field::bn254::lt(low.value, value));
    let is_max = low.next_value == 0;
    assert(!enabled | is_max | std::field::bn254::lt(value, low.next_value));

    // (3) repoint the low leaf at the new node -> intermediate root r1.
    let new_index = bits_to_field(new_index_bits);
    let updated_low =
        ImtLeaf { value: low.value, next_value: value, next_index: new_index };
    let r1 = fold_root(updated_low.hash(), low_path, low_index_bits);

    // (4) the append slot is empty in r1 (the same path is reused to write it) (gated).
    assert(e * (fold_root(0, new_path, new_index_bits) - r1) == 0);

    // (5) write the new leaf, splicing it into the list after the low leaf.
    let new_leaf =
        ImtLeaf { value, next_value: low.next_value, next_index: low.next_index };
    let computed = fold_root(new_leaf.hash(), new_path, new_index_bits);

    // enabled -> computed root_out; disabled -> pass root_in straight through.
    (computed - root_in) * e + root_in
}

// --- Tests -------------------------------------------------------------------

#[test]
fn test_hash_conventions() {
    // Byte-identity guard: compress(0,0) must equal the contract's TREE_ZEROS[1]
    // (soroban-poseidon BN254 t=4). If this drifts, leaves/nullifiers won't match on-chain.
    assert(
        compress(0, 0)
            == 0x18dfb8dc9b82229cff974efefc8df78b1ce96d9d844236b496785c698bc6732e,
    );
    assert(hash3(1, 2, 3) == compress(compress(1, 2), 3));
}

// Test scaffolding: zero-subtree ladder, and paths for a tree holding leaves at
// indices 0 and 1 (everything else empty). Sufficient to exercise the genesis insert
// and one follow-on insert without a full 2^32 tree.
fn zeros() -> [Field; TREE_DEPTH] {
    let mut z = [0; TREE_DEPTH];
    for i in 1..TREE_DEPTH {
        z[i] = compress(z[i - 1], z[i - 1]);
    }
    z
}

fn bits0() -> [Field; TREE_DEPTH] {
    [0; TREE_DEPTH]
}

fn bits1() -> [Field; TREE_DEPTH] {
    let mut b = [0; TREE_DEPTH];
    b[0] = 1;
    b
}

// Path for index 0 when index 1 holds `leaf1` (rest empty): sibling at level 0 is leaf1,
// higher levels are zero subtrees.
fn path_idx0(leaf1: Field, z: [Field; TREE_DEPTH]) -> [Field; TREE_DEPTH] {
    let mut p = z;
    p[0] = leaf1;
    p
}

// Path for index 1 when index 0 holds `leaf0` (rest empty): sibling at level 0 is leaf0.
fn path_idx1(leaf0: Field, z: [Field; TREE_DEPTH]) -> [Field; TREE_DEPTH] {
    let mut p = z;
    p[0] = leaf0;
    p
}

#[test]
fn test_imt_genesis_insert() {
    let z = zeros();
    // Genesis: only leaf 0 = {0,0,0} occupied.
    let genesis = ImtLeaf { value: 0, next_value: 0, next_index: 0 };
    let root_in = fold_root(genesis.hash(), z, bits0());

    let v = 5;
    // low = genesis (idx 0); new leaf goes to idx 1.
    let updated_low = ImtLeaf { value: 0, next_value: v, next_index: 1 };
    let new_path = path_idx1(updated_low.hash(), z);
    let root_out =
        imt_insert(root_in, v, genesis, z, bits0(), new_path, bits1());

    // Expected: tree with leaf0 = updated_low, leaf1 = {v,0,0}.
    let new_leaf = ImtLeaf { value: v, next_value: 0, next_index: 0 };
    let expected = fold_root(new_leaf.hash(), path_idx1(updated_low.hash(), z), bits1());
    assert(root_out == expected);
    // Sanity: folding the updated low at idx0 with leaf1 sibling gives the same root.
    let check = fold_root(updated_low.hash(), path_idx0(new_leaf.hash(), z), bits0());
    assert(check == root_out);
}

#[test(should_fail)]
fn test_imt_reinsert_rejected() {
    // Re-inserting an existing value must fail the range check.
    let z = zeros();
    // Set: {0 -> 5 -> inf}. low for re-inserting 5 would be the {0,5,1} leaf at idx0,
    // but 5 is not < 5, so the upper-bound range check fails.
    let low = ImtLeaf { value: 0, next_value: 5, next_index: 1 };
    let leaf1 = ImtLeaf { value: 5, next_value: 0, next_index: 0 };
    let root_in = fold_root(low.hash(), path_idx0(leaf1.hash(), z), bits0());
    // Attempt to insert 5 again at a fresh slot (idx 1 path is illustrative).
    let _ = imt_insert(root_in, 5, low, path_idx0(leaf1.hash(), z), bits0(), z, bits1());
}

#[test]
fn test_imt_insert_opt_disabled_is_noop() {
    // Disabled insert imposes no constraints and returns root_in unchanged (dummy zero witnesses).
    let z = zeros();
    let root_in = 0x1234567890abcdef;
    let dummy_low = ImtLeaf { value: 0, next_value: 0, next_index: 0 };
    let out = imt_insert_opt(false, root_in, 0, dummy_low, z, bits0(), z, bits0());
    assert(out == root_in);
}

#[test(should_fail)]
fn test_imt_low_not_member() {
    // A low leaf that isn't actually in root_in must fail the membership check.
    let z = zeros();
    let real = ImtLeaf { value: 0, next_value: 0, next_index: 0 };
    let root_in = fold_root(real.hash(), z, bits0());
    let fake_low = ImtLeaf { value: 1, next_value: 0, next_index: 0 };
    let _ = imt_insert(root_in, 9, fake_low, z, bits0(), z, bits1());
}
