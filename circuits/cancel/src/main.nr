// cancel circuit - authorize removing a resting order from the on-chain book and returning its
// locked funds. Unlike lift/unshield there is NO Merkle membership proof: the resting order lives in
// plaintext contract storage (order terms are public), so the contract looks the entry up directly.
// What this proves is *authority*: the caller knows the secret behind the order's `cancel_owner_tag`,
// and it binds which order is being cancelled (`order_leaf`) and where the funds go
// (`return_owner_tag`) so a relayer can submit the cancel without being able to retarget it.
//
// cancel_owner_tag is the order's cancel-authority tag, set when the order was lifted:
//   pk_o            = compress(sk_o, 0)
//   cancel_owner_tag = compress(pk_o, rho_ord)        // rho_ord is the order's cancel randomness
//
// Public inputs (4 x 32-byte big-endian field elements; order matches the contract):
//   [0] domain            must equal CANCEL_DOMAIN (distinct from lift=1 / unshield=2)
//   [1] order_leaf        identifies the resting order to cancel (the lift `order_leaf`)
//   [2] cancel_owner_tag  the order's cancel-authority tag (contract checks it == the stored entry's)
//   [3] return_owner_tag  stealth tag the returned funds are minted to (binds the payout destination)

global CANCEL_DOMAIN: Field = 3;

// 2-to-1 Poseidon2 compression (width-4 permutation, first lane) - identical to lift/unshield.
fn compress(a: Field, b: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, 0, 0], 4)[0]
}

fn main(
    // --- private witness ---
    sk_o: Field,       // owner secret
    rho_ord: Field,    // the order's cancel randomness (cancel_owner_tag = compress(pk_o, rho_ord))
    // --- public inputs ---
    domain: pub Field,
    order_leaf: pub Field,
    cancel_owner_tag: pub Field,
    return_owner_tag: pub Field,
) {
    // domain separation: this proof is only valid as a cancel.
    assert(domain == CANCEL_DOMAIN);

    // authority: reconstruct cancel_owner_tag from the secrets; only the order's owner can.
    let pk_o = compress(sk_o, 0);
    assert(compress(pk_o, rho_ord) == cancel_owner_tag);

    // bind the cancelled order and the return destination into the constraint system so the proof
    // commits to exactly one order and one payout tag (a relayer cannot swap either).
    let bound = compress(compress(order_leaf, return_owner_tag), cancel_owner_tag);
    assert(bound != 0);
}
