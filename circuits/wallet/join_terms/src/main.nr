// Wallet helper: derive every public field a join proof binds, from the per-note secrets and
// randomness. Executed in-browser via noir_js (NOT proved). Matches circuits/join exactly.
//
//   nullifier_1 = compress(sk_1, rho_1)                 // consumed note 1 (its own secret)
//   nullifier_2 = compress(sk_2, rho_2)                 // consumed note 2 (its own secret)
//   out_tag_1   = compress(compress(sk_out1,0), rho_out1) // target note destination
//   out_tag_2   = compress(compress(sk_out2,0), rho_out2) // change note destination
//
// Returns (nullifier_1, nullifier_2, out_tag_1, out_tag_2). The wallet uses per-note keys, so each
// input has its own sk and each fresh output note gets its own sk too.

fn compress(a: Field, b: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, 0, 0], 4)[0]
}

fn main(
    sk_1: Field,
    rho_1: Field,
    sk_2: Field,
    rho_2: Field,
    sk_out1: Field,
    rho_out1: Field,
    sk_out2: Field,
    rho_out2: Field,
) -> pub (Field, Field, Field, Field) {
    let nullifier_1 = compress(sk_1, rho_1);
    let nullifier_2 = compress(sk_2, rho_2);
    let out_tag_1 = compress(compress(sk_out1, 0), rho_out1);
    let out_tag_2 = compress(compress(sk_out2, 0), rho_out2);
    (nullifier_1, nullifier_2, out_tag_1, out_tag_2)
}
