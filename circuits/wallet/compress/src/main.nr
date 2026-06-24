// Wallet helper: the raw 2-to-1 Poseidon2 compression the whole scheme is built on. Executed
// in-browser via noir_js (NOT proved). The wallet uses it to derive the match-time per-note nonce
// `nonce = compress(taker_leaf, slot)` and a proceeds note's owner tag
// `note_owner_tag = compress(output_owner_tag, nonce)` - so it can recompute the tags the `match`
// circuit minted under and find/spend its proceeds. Byte-identical to the mosaic lib's `compress`.

use mosaic::compress;

fn main(a: Field, b: Field) -> pub Field {
    compress(a, b)
}
