// match circuit (WS4.2) - settle a taker against up to 3 makers, verified on-chain by `settle_match`.
//
// Model (full-fill makers, taker-side remainder):
//   - 1 taker order is crossed against up to 3 maker orders on the same registered pair (makers on
//     the side opposite the taker). Makers are FULLY consumed; the taker may leave a remainder.
//   - Each maker gives `asset_out_T` (what the taker wants) and is paid its `min_out` of `asset_in_T`
//     (the maker's own limit price). The taker receives the sum of the makers' `amount_in`.
//   - The taker pays sum(maker.min_out) of `asset_in_T`; its leftover (amount_in_T - that sum) is
//     re-rested as a new order preserving the taker's exact limit ratio.
//
// Outputs (all bound, the contract mints them verbatim):
//   proceeds[0] = taker:   (asset_out_T, sum(maker.amount_in), note_tag(taker.out_tag, nonce0))
//   proceeds[1+i] = maker i:(asset_in_T,  maker.min_out_i,     note_tag(maker.out_tag_i, nonce_{1+i}))   [if real]
//   remainder = the taker's leftover order (if any), re-rested under the taker's own tags + ratio.
// Per-note nonce = compress(taker_leaf, slot) keeps every minted note uniquely spendable.
//
// Public inputs (27 fields): [0] domain [1] order_root [2] nf_root_in [3] nf_root_out [4] now
//   [5..9] consumed order nullifiers (taker, maker0..2; 0 = unused)
//   [9..25] four proceeds slots {live, asset, amount, note_owner_tag}
//   [25] remainder_live [26] remainder_order_leaf.

use mosaic::{
    fold_root, imt_insert, imt_insert_opt, ImtLeaf, lte, note_owner_tag,
    order_consumption_nullifier, order_leaf as build_order_leaf, TREE_DEPTH,
};

global MATCH_DOMAIN: Field = 5;
global N_MAKERS: u32 = 3;
global AMOUNT_BITS: u32 = 124;

fn nonce(taker_leaf: Field, slot: Field) -> Field {
    mosaic::compress(taker_leaf, slot)
}

fn main(
    // --- taker order (private terms + membership) ---
    t_asset_in: Field,
    t_amount_in: Field,
    t_asset_out: Field,
    t_min_out: Field,
    t_out_tag: Field,
    t_cancel_tag: Field,
    t_expiry: Field,
    t_partial: Field,
    t_path: [Field; TREE_DEPTH],
    t_index_bits: [Field; TREE_DEPTH],
    // taker nullifier IMT witnesses
    t_low_value: Field,
    t_low_next_value: Field,
    t_low_next_index: Field,
    t_low_path: [Field; TREE_DEPTH],
    t_low_index_bits: [Field; TREE_DEPTH],
    t_new_path: [Field; TREE_DEPTH],
    t_new_index_bits: [Field; TREE_DEPTH],
    t_pred_leaf: Field, // leaf at taker new_index-1 (append-frontier proof)
    t_pred_path: [Field; TREE_DEPTH],
    t_pred_index_bits: [Field; TREE_DEPTH],
    // --- up to 3 makers (amount_in == 0 => unused slot) ---
    m_asset_in: [Field; N_MAKERS],
    m_amount_in: [Field; N_MAKERS],
    m_asset_out: [Field; N_MAKERS],
    m_min_out: [Field; N_MAKERS],
    m_out_tag: [Field; N_MAKERS],
    m_cancel_tag: [Field; N_MAKERS],
    m_expiry: [Field; N_MAKERS],
    m_partial: [Field; N_MAKERS],
    m_path: [[Field; TREE_DEPTH]; N_MAKERS],
    m_index_bits: [[Field; TREE_DEPTH]; N_MAKERS],
    // maker nullifier IMT witnesses
    m_low_value: [Field; N_MAKERS],
    m_low_next_value: [Field; N_MAKERS],
    m_low_next_index: [Field; N_MAKERS],
    m_low_path: [[Field; TREE_DEPTH]; N_MAKERS],
    m_low_index_bits: [[Field; TREE_DEPTH]; N_MAKERS],
    m_new_path: [[Field; TREE_DEPTH]; N_MAKERS],
    m_new_index_bits: [[Field; TREE_DEPTH]; N_MAKERS],
    m_pred_leaf: [Field; N_MAKERS], // leaf at each maker new_index-1 (append-frontier proof; gated)
    m_pred_path: [[Field; TREE_DEPTH]; N_MAKERS],
    m_pred_index_bits: [[Field; TREE_DEPTH]; N_MAKERS],
    // --- public inputs ---
    domain: pub Field,
    order_root: pub Field,
    nullifier_root_in: pub Field,
    nullifier_root_out: pub Field,
    now: pub Field,
    nf_taker: pub Field,
    nf_maker0: pub Field,
    nf_maker1: pub Field,
    nf_maker2: pub Field,
    p0_live: pub Field,
    p0_asset: pub Field,
    p0_amount: pub Field,
    p0_tag: pub Field,
    p1_live: pub Field,
    p1_asset: pub Field,
    p1_amount: pub Field,
    p1_tag: pub Field,
    p2_live: pub Field,
    p2_asset: pub Field,
    p2_amount: pub Field,
    p2_tag: pub Field,
    p3_live: pub Field,
    p3_asset: pub Field,
    p3_amount: pub Field,
    p3_tag: pub Field,
    remainder_live: pub Field,
    rem_asset_in: pub Field,
    rem_amount_in: pub Field,
    rem_asset_out: pub Field,
    rem_min_out: pub Field,
    rem_output_owner_tag: pub Field,
    rem_cancel_owner_tag: pub Field,
    rem_expiry: pub Field,
    rem_partial_allowed: pub Field,
    remainder_order_leaf: pub Field,
) {
    assert(domain == MATCH_DOMAIN);

    // --- taker: membership, expiry, nullifier consume ---
    let taker_leaf = build_order_leaf(
        t_asset_in,
        t_amount_in,
        t_asset_out,
        t_min_out,
        t_out_tag,
        t_cancel_tag,
        t_expiry,
        t_partial,
    );
    assert(fold_root(taker_leaf, t_path, t_index_bits) == order_root);
    assert(lte(now, t_expiry)); // taker not expired
    t_amount_in.assert_max_bit_size::<AMOUNT_BITS>();
    t_min_out.assert_max_bit_size::<AMOUNT_BITS>();

    let nf_t = order_consumption_nullifier(taker_leaf);
    assert(nf_t == nf_taker);
    let t_low = ImtLeaf { value: t_low_value, next_value: t_low_next_value, next_index: t_low_next_index };
    let mut nf_root = imt_insert(
        nullifier_root_in,
        nf_t,
        t_low,
        t_low_path,
        t_low_index_bits,
        t_new_path,
        t_new_index_bits,
        t_pred_leaf,
        t_pred_path,
        t_pred_index_bits,
    );

    // --- makers: each fully filled; accumulate proceeds + payment ---
    let nf_makers_pub = [nf_maker0, nf_maker1, nf_maker2];
    let mut total_out: Field = 0; // asset_out_T the taker receives
    let mut total_in_paid: Field = 0; // asset_in_T the taker pays out to makers
    let mut prev_real: Field = 1; // for canonical packing (real slots come first)
    // maker proceeds (asset, amount, tag, live) computed per slot for later assertion.
    let mut m_proc_amount: [Field; N_MAKERS] = [0; N_MAKERS];
    let mut m_proc_tag: [Field; N_MAKERS] = [0; N_MAKERS];
    let mut m_real_f: [Field; N_MAKERS] = [0; N_MAKERS];

    for i in 0..N_MAKERS {
        let real = m_amount_in[i] != 0;
        let real_f = real as Field;
        m_real_f[i] = real_f;
        // canonical packing: a real slot cannot follow a null slot.
        assert(real_f * (1 - prev_real) == 0);
        prev_real = real_f;

        m_amount_in[i].assert_max_bit_size::<AMOUNT_BITS>();
        m_min_out[i].assert_max_bit_size::<AMOUNT_BITS>();
        // a real maker must demand positive payment. With >=1 real maker this forces total_in_paid
        // >= 1, so any taker remainder strictly shrinks amount_in -> the re-rested remainder leaf can
        // never equal the consumed taker leaf (whose nullifier is already spent), which would
        // otherwise lock the remainder forever.
        assert(!real | (m_min_out[i] != 0));

        let leaf = build_order_leaf(
            m_asset_in[i],
            m_amount_in[i],
            m_asset_out[i],
            m_min_out[i],
            m_out_tag[i],
            m_cancel_tag[i],
            m_expiry[i],
            m_partial[i],
        );
        // membership (gated): the maker is in the same accepted order root.
        let r = fold_root(leaf, m_path[i], m_index_bits[i]);
        assert(real_f * (r - order_root) == 0);
        // assets cross the taker (gated): maker gives asset_out_T, wants asset_in_T.
        assert(real_f * (m_asset_in[i] - t_asset_out) == 0);
        assert(real_f * (m_asset_out[i] - t_asset_in) == 0);
        // price cross (gated): t_min_out * m_min_out <= t_amount_in * m_amount_in.
        let lhs = t_min_out * m_min_out[i];
        let rhs = t_amount_in * m_amount_in[i];
        assert(!real | lte(lhs, rhs));
        // expiry (gated).
        assert(!real | lte(now, m_expiry[i]));

        // consumption nullifier (gated): public slot is the nullifier when real, else 0.
        let nf_m = order_consumption_nullifier(leaf);
        assert(nf_makers_pub[i] == real_f * nf_m);
        let low = ImtLeaf {
            value: m_low_value[i],
            next_value: m_low_next_value[i],
            next_index: m_low_next_index[i],
        };
        nf_root = imt_insert_opt(
            real,
            nf_root,
            nf_m,
            low,
            m_low_path[i],
            m_low_index_bits[i],
            m_new_path[i],
            m_new_index_bits[i],
            m_pred_leaf[i],
            m_pred_path[i],
            m_pred_index_bits[i],
        );

        // accumulate (gated): taker receives maker.amount_in; pays maker.min_out.
        total_out += real_f * m_amount_in[i];
        total_in_paid += real_f * m_min_out[i];
        m_proc_amount[i] = real_f * m_min_out[i];
        m_proc_tag[i] = real_f
            * note_owner_tag(m_out_tag[i], nonce(taker_leaf, (i + 1) as Field));
    }

    // at least one maker must be real (canonical packing puts it in slot 0).
    assert(m_real_f[0] == 1);

    // IMT transition closes out.
    assert(nf_root == nullifier_root_out);

    // --- proceeds slot 0: the taker's fill ---
    assert(p0_live == 1);
    assert(p0_asset == t_asset_out);
    assert(p0_amount == total_out);
    assert(p0_tag == note_owner_tag(t_out_tag, nonce(taker_leaf, 0)));

    // --- proceeds slots 1..4: the makers' fills ---
    let p_live = [p1_live, p2_live, p3_live];
    let p_asset = [p1_asset, p2_asset, p3_asset];
    let p_amount = [p1_amount, p2_amount, p3_amount];
    let p_tag = [p1_tag, p2_tag, p3_tag];
    for i in 0..N_MAKERS {
        assert(p_live[i] == m_real_f[i]);
        assert(p_asset[i] == m_real_f[i] * t_asset_in);
        assert(p_amount[i] == m_proc_amount[i]);
        assert(p_tag[i] == m_proc_tag[i]);
    }

    // --- taker remainder (re-rested order; ALL terms are public so the contract can emit them and
    // a fully-direct client reconstructs the order from events alone) ---
    // taker cannot pay more than it holds; leftover re-rests at the taker's exact limit ratio.
    assert(lte(total_in_paid, t_amount_in));
    let remainder = t_amount_in - total_in_paid;
    let rem_real = remainder != 0;
    let rem_real_f = rem_real as Field;
    // a live remainder partially fills the taker, so it is only allowed if the taker authorized
    // partial fills (t_partial is pinned by taker_leaf membership, so it cannot be forged).
    assert(rem_real_f * (t_partial - 1) == 0);
    assert(remainder_live == rem_real_f);
    // when live, the remainder inherits the taker's asset/tags/expiry/flag and carries the leftover
    // amount at the taker's exact limit ratio; when not live every public field is forced to 0.
    assert(rem_asset_in == rem_real_f * t_asset_in);
    assert(rem_asset_out == rem_real_f * t_asset_out);
    assert(rem_output_owner_tag == rem_real_f * t_out_tag);
    assert(rem_cancel_owner_tag == rem_real_f * t_cancel_tag);
    assert(rem_expiry == rem_real_f * t_expiry);
    assert(rem_partial_allowed == rem_real_f * t_partial);
    assert(rem_amount_in == rem_real_f * remainder);
    assert((1 - rem_real_f) * rem_min_out == 0);
    assert(rem_real_f * (rem_min_out * t_amount_in - t_min_out * rem_amount_in) == 0);
    let computed_rem_leaf = build_order_leaf(
        rem_asset_in,
        rem_amount_in,
        rem_asset_out,
        rem_min_out,
        rem_output_owner_tag,
        rem_cancel_owner_tag,
        rem_expiry,
        rem_partial_allowed,
    );
    assert(remainder_order_leaf == rem_real_f * computed_rem_leaf);
}

// --- test harness: a full valid 1-taker x 1-maker match, exercised for the P1 negatives ----------
//
// Builds a complete, self-consistent witness (order tree with the two leaves, genesis IMT advanced by
// the taker + maker consumption nullifiers, proceeds + remainder) and calls `main`. The happy case
// must pass; the two `should_fail` cases flip exactly one term so the FIRST failing constraint is the
// P1 check under test (the order tree / IMT / proceeds are rebuilt for the flipped term so they still
// pass). Tree helpers mirror circuits/mosaic/src/lib.nr's IMT tests.

fn z_ladder() -> [Field; TREE_DEPTH] {
    let mut z = [0; TREE_DEPTH];
    for i in 1..TREE_DEPTH {
        z[i] = mosaic::compress(z[i - 1], z[i - 1]);
    }
    z
}
fn bits_0() -> [Field; TREE_DEPTH] {
    [0; TREE_DEPTH]
}
fn bits_1() -> [Field; TREE_DEPTH] {
    let mut b = [0; TREE_DEPTH];
    b[0] = 1;
    b
}
fn bits_2() -> [Field; TREE_DEPTH] {
    let mut b = [0; TREE_DEPTH];
    b[1] = 1;
    b
}
// Path for index 0 or 1 (sibling at level 0 is the other leaf; higher levels are zero subtrees).
fn path_lvl0(sib0: Field, z: [Field; TREE_DEPTH]) -> [Field; TREE_DEPTH] {
    let mut p = z;
    p[0] = sib0;
    p
}
// Path for index 2 when indices 0,1 hold leaf0,leaf1 (rest empty): sibling at level 1 is H(leaf0,leaf1).
fn path_idx2(leaf0: Field, leaf1: Field, z: [Field; TREE_DEPTH]) -> [Field; TREE_DEPTH] {
    let mut p = z;
    p[1] = mosaic::compress(leaf0, leaf1);
    p
}

struct Ins {
    low_value: Field,
    low_next_value: Field,
    low_next_index: Field,
    low_path: [Field; TREE_DEPTH],
    low_bits: [Field; TREE_DEPTH],
    new_path: [Field; TREE_DEPTH],
    new_bits: [Field; TREE_DEPTH],
    pred_leaf: Field,
    pred_path: [Field; TREE_DEPTH],
    pred_bits: [Field; TREE_DEPTH],
}

// Witnesses to consume nf_t then nf_m against a fresh (genesis) IMT. Returns (root_in, root_out, taker
// insert, maker insert), branching on the two nullifiers' order so the maker's low leaf is correct.
fn imt_two(nf_t: Field, nf_m: Field) -> (Field, Field, Ins, Ins) {
    let z = z_ladder();
    let genesis = ImtLeaf { value: 0, next_value: 0, next_index: 0 };
    let root_in = fold_root(genesis.hash(), z, bits_0());

    // taker insert at idx 1 (low = genesis at idx 0).
    let updated_low_t = ImtLeaf { value: 0, next_value: nf_t, next_index: 1 };
    let leaf_t = ImtLeaf { value: nf_t, next_value: 0, next_index: 0 };
    let it = Ins {
        low_value: 0,
        low_next_value: 0,
        low_next_index: 0,
        low_path: z,
        low_bits: bits_0(),
        new_path: path_lvl0(updated_low_t.hash(), z),
        new_bits: bits_1(),
        pred_leaf: updated_low_t.hash(),
        pred_path: z,
        pred_bits: bits_0(),
    };

    // maker insert at idx 2 against the post-taker root; list {0 -> nf_t -> inf}, leaf0=updated_low_t,
    // leaf1=leaf_t (the maker witnesses below fold to that intermediate root, which `main` rethreads).
    let (im, root_out) = if std::field::bn254::lt(nf_t, nf_m) {
        // nf_m > nf_t: low = leaf1 (current max).
        let updated_low_m = ImtLeaf { value: nf_t, next_value: nf_m, next_index: 2 };
        let leaf_m = ImtLeaf { value: nf_m, next_value: 0, next_index: 0 };
        let new_path_m = path_idx2(updated_low_t.hash(), updated_low_m.hash(), z);
        let im = Ins {
            low_value: nf_t,
            low_next_value: 0,
            low_next_index: 0,
            low_path: path_lvl0(updated_low_t.hash(), z),
            low_bits: bits_1(),
            new_path: new_path_m,
            new_bits: bits_2(),
            pred_leaf: updated_low_m.hash(),
            pred_path: path_lvl0(updated_low_t.hash(), z),
            pred_bits: bits_1(),
        };
        (im, fold_root(leaf_m.hash(), new_path_m, bits_2()))
    } else {
        // nf_m < nf_t: low = leaf0 (genesis, already repointed to nf_t).
        let updated_low_m = ImtLeaf { value: 0, next_value: nf_m, next_index: 2 };
        let leaf_m = ImtLeaf { value: nf_m, next_value: nf_t, next_index: 1 };
        let new_path_m = path_idx2(updated_low_m.hash(), leaf_t.hash(), z);
        let im = Ins {
            low_value: 0,
            low_next_value: nf_t,
            low_next_index: 1,
            low_path: path_lvl0(leaf_t.hash(), z),
            low_bits: bits_0(),
            new_path: new_path_m,
            new_bits: bits_2(),
            pred_leaf: leaf_t.hash(),
            pred_path: path_lvl0(updated_low_m.hash(), z),
            pred_bits: bits_1(),
        };
        (im, fold_root(leaf_m.hash(), new_path_m, bits_2()))
    };
    (root_in, root_out, it, im)
}

// Run a valid match with the given taker partial flag, maker payment, and (reached only on the happy
// path) remainder limit. Taker: give 100 a1, want >=40 a2, partial=`t_partial`. Maker0: give 60 a2,
// want `m0_min_out` a1. Taker receives 60 a2, pays `m0_min_out` a1, re-rests the leftover.
fn run_match(t_partial: Field, m0_min_out: Field, rem_min_out: Field) {
    let z = z_ladder();
    let t_out_tag = 0x44;
    let t_cancel_tag = 0x55;
    let t_expiry = 100000;
    let now = 100;
    let taker_leaf = build_order_leaf(1, 100, 2, 40, t_out_tag, t_cancel_tag, t_expiry, t_partial);

    let m_out_tag0 = 0x66;
    let m_cancel_tag0 = 0x77;
    let maker_leaf = build_order_leaf(2, 60, 1, m0_min_out, m_out_tag0, m_cancel_tag0, t_expiry, 1);

    // Order tree: taker @0, maker @1.
    let order_root = fold_root(taker_leaf, path_lvl0(maker_leaf, z), bits_0());

    // Consumption nullifiers + their sequential IMT inserts.
    let nf_t = order_consumption_nullifier(taker_leaf);
    let nf_m = order_consumption_nullifier(maker_leaf);
    let (root_in, root_out, it, im) = imt_two(nf_t, nf_m);

    let total_out = 60; // a2 the taker receives = maker.amount_in
    let total_in_paid = m0_min_out; // a1 the taker pays = maker.min_out
    let remainder = 100 - total_in_paid;
    let p0_tag = note_owner_tag(t_out_tag, nonce(taker_leaf, 0));
    let p1_tag = note_owner_tag(m_out_tag0, nonce(taker_leaf, 1));
    let rem_leaf = build_order_leaf(1, remainder, 2, rem_min_out, t_out_tag, t_cancel_tag, t_expiry, t_partial);

    let zb = bits_0(); // zero index-bits for disabled maker slots
    let zeros: [Field; TREE_DEPTH] = [0; TREE_DEPTH];

    main(
        // taker order
        1, 100, 2, 40, t_out_tag, t_cancel_tag, t_expiry, t_partial,
        path_lvl0(maker_leaf, z), bits_0(),
        it.low_value, it.low_next_value, it.low_next_index, it.low_path, it.low_bits, it.new_path,
        it.new_bits, it.pred_leaf, it.pred_path, it.pred_bits,
        // makers (slot 0 real; 1,2 null)
        [2, 0, 0], [60, 0, 0], [1, 0, 0], [m0_min_out, 0, 0], [m_out_tag0, 0, 0], [m_cancel_tag0, 0, 0],
        [t_expiry, 0, 0], [1, 0, 0],
        [path_lvl0(taker_leaf, z), zeros, zeros], [bits_1(), zb, zb],
        [im.low_value, 0, 0], [im.low_next_value, 0, 0], [im.low_next_index, 0, 0],
        [im.low_path, zeros, zeros], [im.low_bits, zb, zb],
        [im.new_path, zeros, zeros], [im.new_bits, zb, zb],
        [im.pred_leaf, 0, 0], [im.pred_path, zeros, zeros], [im.pred_bits, zb, zb],
        // public inputs
        5, order_root, root_in, root_out, now,
        nf_t, nf_m, 0, 0,
        1, 2, total_out, p0_tag, // proceeds 0: taker
        1, 1, total_in_paid, p1_tag, // proceeds 1: maker0
        0, 0, 0, 0, // proceeds 2
        0, 0, 0, 0, // proceeds 3
        1, 1, remainder, 2, rem_min_out, t_out_tag, t_cancel_tag, t_expiry, t_partial, rem_leaf,
    );
}

#[test]
fn match_happy_path_partial_taker() {
    // partial=1, maker pays 50 -> remainder 50 re-rests at the taker's ratio (rem_min_out 20).
    run_match(1, 50, 20);
}

#[test(should_fail)]
fn match_rejects_partial_when_not_allowed() {
    // A live remainder partially fills the taker, forbidden when partial_allowed=0 (P1).
    run_match(0, 50, 20);
}

#[test(should_fail)]
fn match_rejects_zero_price_maker() {
    // A real maker demanding zero payment is rejected (P1) before it can lock the remainder.
    run_match(1, 0, 40);
}
