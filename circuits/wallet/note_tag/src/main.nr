// Wallet helper: derive a minted note's public owner tag from the owner secret, per-note
// randomness, and the per-note nonce. Executed in-browser via noir_js (NOT proved) to fill the
// shield call's owner_tag. Byte-identical to the mosaic lib used by the spend circuits.
//
//   note_owner_tag = compress(compress(compress(sk,0), rho), nonce)

use mosaic::{note_owner_tag, output_owner_tag, pk_from_sk};

fn main(sk: Field, rho: Field, nonce: Field) -> pub Field {
    note_owner_tag(output_owner_tag(pk_from_sk(sk), rho), nonce)
}
