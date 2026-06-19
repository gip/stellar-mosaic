// Wallet helper: derive a note's public owner_tag from the owner secret + per-note randomness.
// Executed in-browser via noir_js (NOT proved) to fill the shield call's owner_tag. Uses the
// exact compress convention as circuits/lift, so the value is byte-identical to the contract.
//
//   pk_o      = compress(sk, 0)
//   owner_tag = compress(pk_o, rho)

fn compress(a: Field, b: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, 0, 0], 4)[0]
}

fn main(sk: Field, rho: Field) -> pub Field {
    let pk_o = compress(sk, 0);
    compress(pk_o, rho)
}
