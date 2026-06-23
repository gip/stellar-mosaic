// Wallet helper: derive every public field a join proof binds, from the per-note secrets and
// randomness. Executed in-browser via noir_js (NOT proved). Byte-identical to the mosaic lib used
// by circuits/join.
//
//   nullifier_i = compress(sk_i, compress(rho_i, nonce_i))               // consumed note (nonce-aware)
//   out_tag_i   = compress(compress(compress(sk_outi,0), rho_outi), nonce_outi) // fresh output note
//
// Returns (nullifier_1, nullifier_2, out_tag_1, out_tag_2). The wallet uses per-note keys, and each
// fresh output note gets its own nonce so it is uniquely spendable.

use mosaic::{note_nullifier, note_owner_tag, output_owner_tag, pk_from_sk};

fn main(
    sk_1: Field,
    rho_1: Field,
    nonce_1: Field,
    sk_2: Field,
    rho_2: Field,
    nonce_2: Field,
    sk_out1: Field,
    rho_out1: Field,
    nonce_out1: Field,
    sk_out2: Field,
    rho_out2: Field,
    nonce_out2: Field,
) -> pub (Field, Field, Field, Field) {
    let nullifier_1 = note_nullifier(sk_1, rho_1, nonce_1);
    let nullifier_2 = note_nullifier(sk_2, rho_2, nonce_2);
    let out_tag_1 =
        note_owner_tag(output_owner_tag(pk_from_sk(sk_out1), rho_out1), nonce_out1);
    let out_tag_2 =
        note_owner_tag(output_owner_tag(pk_from_sk(sk_out2), rho_out2), nonce_out2);
    (nullifier_1, nullifier_2, out_tag_1, out_tag_2)
}
