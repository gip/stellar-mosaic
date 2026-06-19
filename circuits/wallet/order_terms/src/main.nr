// Wallet helper: derive every public field a lift (order) proof binds, from the owner secret and
// per-note randomness. Executed in-browser via noir_js (NOT proved). Matches circuits/lift exactly.
//
//   nullifier_in     = compress(sk, rho_in)
//   output_owner_tag = compress(compress(sk,0), rho_out)   // proceeds destination
//   cancel_owner_tag = compress(compress(sk,0), rho_ord)   // cancel authority
//   order_leaf       = H8(asset_in, amount_in, asset_out, min_out,
//                         output_owner_tag, cancel_owner_tag, expiry, partial_allowed)
//
// Returns (nullifier_in, output_owner_tag, cancel_owner_tag, order_leaf).

fn compress(a: Field, b: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, 0, 0], 4)[0]
}

fn hash8(a: Field, b: Field, c: Field, d: Field, e: Field, f: Field, g: Field, h: Field) -> Field {
    let mut acc = compress(a, b);
    acc = compress(acc, c);
    acc = compress(acc, d);
    acc = compress(acc, e);
    acc = compress(acc, f);
    acc = compress(acc, g);
    compress(acc, h)
}

fn main(
    sk: Field,
    rho_in: Field,
    rho_out: Field,
    rho_ord: Field,
    asset_in: Field,
    amount_in: Field,
    asset_out: Field,
    min_out: Field,
    expiry: Field,
    partial_allowed: Field,
) -> pub (Field, Field, Field, Field) {
    let nullifier_in = compress(sk, rho_in);
    let pk_o = compress(sk, 0);
    let output_owner_tag = compress(pk_o, rho_out);
    let cancel_owner_tag = compress(pk_o, rho_ord);
    let order_leaf = hash8(
        asset_in,
        amount_in,
        asset_out,
        min_out,
        output_owner_tag,
        cancel_owner_tag,
        expiry,
        partial_allowed,
    );
    (nullifier_in, output_owner_tag, cancel_owner_tag, order_leaf)
}
