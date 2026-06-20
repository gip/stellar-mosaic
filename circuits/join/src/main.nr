// join circuit - consolidate two asset notes of the same asset into two fresh asset notes
// (target + change), without unshielding. This is what lets a wallet assemble an exact
// denomination: {1.5, 2} USDC -> {3, 0.5} USDC, so the full-consumption `lift` order can then
// offer exactly 3. The second input is OPTIONAL: passing a null padding note (amount_2 == 0) turns
// this into a 1->2 SPLIT, so a single note can be carved into {target, change} (e.g. 101 -> 100 + 1)
// with no second note on hand. See docs/note-types.md (the privacy model is owner-anonymous,
// amount-transparent) and docs/lift-circuit-spec.md for the public-input/contract-obligation
// conventions this mirrors.
//
// What this proves (the contract trusts these because the proof verifies):
//   (1) the spender knows the secret behind EACH consumed note's owner_tag (per-note sk, matching
//       the wallet's per-note key model; the two inputs need not share a secret)
//   (2) both consumed asset notes are in the tree at `root` (membership hides WHICH notes)
//   (3) `nullifier_1`/`nullifier_2` are the correct nullifiers (double-spend guard, per note)
//   (4) all five amounts fit a bounded bit size, so value conservation cannot be forged by
//       wrapping the BN254 field, and
//   (5) value is conserved: amount_1 + amount_2 == out_amount_1 + out_amount_2 (one asset)
//   (6) the proof is domain-separated to `join` (not replayable as lift/unshield/cancel)
//
// The output notes' owner_tags are wallet-chosen opaque tags (like lift's output_owner_tag): the
// circuit only binds them into the public inputs so the contract mints exactly those leaves. The
// contract never sees the input amounts; conservation is enforced here.

// Production tree depth - MUST match lift/unshield and the on-chain tree.
global TREE_DEPTH: u32 = 32;

// Domain separator for join proofs. Distinct from lift=1 / unshield=2 / cancel=3.
global JOIN_DOMAIN: Field = 4;

// Max bit size for every amount. Two inputs each < 2^124 sum to < 2^125, far below the BN254
// modulus (~2^254), so `amount_1 + amount_2` cannot overflow the field and a forged conservation
// is impossible. Comfortably covers the contract's i128 range (it accepts amounts < 2^127).
global AMOUNT_BITS: u32 = 124;

// 2-to-1 Poseidon2 compression (width-4 permutation, take the first lane) - identical to lift.
fn compress(a: Field, b: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, 0, 0], 4)[0]
}

// Left-to-right fold: H(a,b,c) = compress(compress(a,b),c). Matches the asset-note leaf hash.
fn hash3(a: Field, b: Field, c: Field) -> Field {
    compress(compress(a, b), c)
}

// Fold `leaf` up its sibling path and return the root it reaches. Index bits are boolean-
// constrained; bit i == 0 => the running node is the LEFT child at level i. Identical to lift's
// fold so the on-chain incremental tree produces matching roots.
fn fold_root(
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

// Membership: the leaf's folded root must equal `root`.
fn assert_member(
    leaf: Field,
    path: [Field; TREE_DEPTH],
    index_bits: [Field; TREE_DEPTH],
    root: Field,
) {
    assert(fold_root(leaf, path, index_bits) == root);
}

fn main(
    // --- private witness ---
    sk_1: Field,                       // consumed note 1 owner secret
    rho_1: Field,                      // consumed note 1 randomness
    amount_1: Field,                   // consumed note 1 amount
    path_1: [Field; TREE_DEPTH],       // note 1 Merkle sibling path
    index_bits_1: [Field; TREE_DEPTH], // note 1 path direction bits
    sk_2: Field,                       // consumed note 2 owner secret
    rho_2: Field,                      // consumed note 2 randomness
    amount_2: Field,                   // consumed note 2 amount
    path_2: [Field; TREE_DEPTH],       // note 2 Merkle sibling path
    index_bits_2: [Field; TREE_DEPTH], // note 2 path direction bits
    // --- public inputs (positional; byte offsets must match the contract's `join`) ---
    domain: pub Field,        // [0] must equal JOIN_DOMAIN
    root: pub Field,          // [1] membership root (contract: published-root history)
    nullifier_1: pub Field,   // [2] consumed note 1 nullifier (contract: unused -> record)
    nullifier_2: pub Field,   // [3] consumed note 2 nullifier (contract: unused -> record)
    asset: pub Field,         // [4] the single asset of both inputs and both outputs
    out_tag_1: pub Field,     // [5] target output note destination tag
    out_amount_1: pub Field,  // [6] target output note amount
    out_tag_2: pub Field,     // [7] change output note destination tag
    out_amount_2: pub Field,  // [8] change output note amount
) {
    // (6) domain separation: this proof is only valid as a join.
    assert(domain == JOIN_DOMAIN);

    // (1) ownership: each consumed note is owned by its own secret (per-note key model).
    let owner_tag_1 = compress(compress(sk_1, 0), rho_1);
    let owner_tag_2 = compress(compress(sk_2, 0), rho_2);

    // (2) membership: consumed note 1 (the real note) leaf = H(asset, amount, owner_tag) is in the
    // tree. Note 2 is OPTIONAL: when amount_2 == 0 it is a null padding note (no second input),
    // which turns this join into a 1->2 SPLIT, a single note carved into {target, change}. A null
    // note contributes 0 to conservation (5), so no value is created and its membership is not
    // required; a real second note (amount_2 != 0) is fully checked exactly as before.
    assert_member(hash3(asset, amount_1, owner_tag_1), path_1, index_bits_1, root);
    let root_2 = fold_root(hash3(asset, amount_2, owner_tag_2), path_2, index_bits_2);
    let real_2 = (amount_2 != 0) as Field; // 1 for a real input, 0 for a null padding note
    assert(real_2 * (root_2 - root) == 0);

    // (3) nullifier correctness for each consumed note (the contract records both, distinct).
    assert(compress(sk_1, rho_1) == nullifier_1);
    assert(compress(sk_2, rho_2) == nullifier_2);

    // (4) bound every amount so conservation cannot be satisfied by wrapping the field.
    amount_1.assert_max_bit_size::<AMOUNT_BITS>();
    amount_2.assert_max_bit_size::<AMOUNT_BITS>();
    out_amount_1.assert_max_bit_size::<AMOUNT_BITS>();
    out_amount_2.assert_max_bit_size::<AMOUNT_BITS>();

    // (5) value conservation: the two fresh notes carry exactly the consumed value, same asset.
    assert(amount_1 + amount_2 == out_amount_1 + out_amount_2);

    // out_tag_1/out_tag_2 are wallet-chosen opaque destination tags (where the contract mints the
    // two outputs). They are already public inputs, so the verifier rejects any tampering; binding
    // them into a constraint matches the cancel circuit's convention and makes the commitment
    // explicit (a relayer cannot redirect either output without producing a new, invalid proof).
    let bound = compress(out_tag_1, out_tag_2);
    assert(bound != 0);
}
