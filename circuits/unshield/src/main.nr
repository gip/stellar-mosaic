// unshield circuit - spend an asset note and authorize transferring the real token out.
//
// Same ownership/membership/nullifier machinery as circuits/lift, but it creates no order: it
// proves the spender owns an asset note in the tree, reveals its nullifier, and binds the public
// withdrawal terms (asset, amount) plus a RECIPIENT so a relayer cannot redirect the funds.
//
// Public inputs (6 x 32-byte big-endian field elements; order matches the contract):
//   [0] domain      must equal UNSHIELD_DOMAIN (distinct from lift, so proofs are not cross-usable)
//   [1] root        membership root (contract checks the published root history)
//   [2] nullifier   spent asset note's nullifier (contract: unused -> record)
//   [3] asset       asset id withdrawn (contract transfers exactly this token)
//   [4] amount      amount withdrawn (contract transfers exactly this)
//   [5] recipient   binds the destination: a field the contract recomputes from the payout address
//                   (sha256(address)), so changing the recipient invalidates the proof.

global TREE_DEPTH: u32 = 32;
global UNSHIELD_DOMAIN: Field = 2;

// 2-to-1 Poseidon2 compression (width-4 permutation, first lane) - identical to lift/spend.
fn compress(a: Field, b: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, 0, 0], 4)[0]
}

fn hash3(a: Field, b: Field, c: Field) -> Field {
    compress(compress(a, b), c)
}

fn main(
    // --- private witness ---
    rho_in: Field,
    sk_o: Field,
    path: [Field; TREE_DEPTH],
    index_bits: [Field; TREE_DEPTH],
    // --- public inputs ---
    domain: pub Field,
    root: pub Field,
    nullifier: pub Field,
    asset: pub Field,
    amount: pub Field,
    recipient: pub Field,
) {
    // domain separation: this proof is only valid as an unshield.
    assert(domain == UNSHIELD_DOMAIN);

    // ownership: reconstruct the spent note's owner_tag from the secrets.
    let pk_o = compress(sk_o, 0);
    let owner_tag = compress(pk_o, rho_in);

    // asset note leaf = H(asset, amount, owner_tag); asset/amount are public withdrawal terms.
    let leaf = hash3(asset, amount, owner_tag);

    // membership: fold the leaf up the path and assert it matches the public root.
    let mut node = leaf;
    for i in 0..TREE_DEPTH {
        let bit = index_bits[i];
        assert(bit * (bit - 1) == 0);
        let sib = path[i];
        let left = (1 - bit) * node + bit * sib;
        let right = (1 - bit) * sib + bit * node;
        node = compress(left, right);
    }
    assert(node == root);

    // nullifier correctness for the spent note.
    assert(compress(sk_o, rho_in) == nullifier);

    // bind the recipient into the constraint system so the proof commits to exactly one payout
    // destination (a relayer cannot swap it without producing a new, invalid proof).
    let bound = compress(nullifier, recipient);
    assert(bound != 0);
}
