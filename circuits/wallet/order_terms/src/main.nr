// Wallet helper: derive every public field a lift (order-placement) proof binds, from the owner
// secret and per-note randomness. Executed in-browser via noir_js (NOT proved). Byte-identical to
// the mosaic lib used by circuits/lift.
//
//   nullifier_in     = compress(sk, compress(rho_in, nonce_in))   // consumed note (nonce-aware)
//   output_owner_tag = compress(compress(sk,0), rho_out)          // proceeds destination base tag
//   cancel_owner_tag = compress(compress(sk,0), rho_ord)          // cancel authority
//   order_leaf       = H8(asset_in, amount_in, asset_out, min_out,
//                         output_owner_tag, cancel_owner_tag, expiry, partial_allowed)
//
// Returns (nullifier_in, output_owner_tag, cancel_owner_tag, order_leaf).

use mosaic::{hash8, note_nullifier, output_owner_tag as derive_output_owner_tag, pk_from_sk};

fn main(
    sk: Field,
    rho_in: Field,
    nonce_in: Field,
    rho_out: Field,
    rho_ord: Field,
    asset_in: Field,
    amount_in: Field,
    asset_out: Field,
    min_out: Field,
    expiry: Field,
    partial_allowed: Field,
) -> pub (Field, Field, Field, Field) {
    let nullifier_in = note_nullifier(sk, rho_in, nonce_in);
    let pk_o = pk_from_sk(sk);
    let output_owner_tag = derive_output_owner_tag(pk_o, rho_out);
    let cancel_owner_tag = derive_output_owner_tag(pk_o, rho_ord);
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
