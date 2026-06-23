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
    // --- taker remainder (re-rested order), if any ---
    rem_amount_in: Field,
    rem_min_out: Field,
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

    // --- taker remainder ---
    // taker cannot pay more than it holds; leftover re-rests at the taker's exact limit ratio.
    assert(lte(total_in_paid, t_amount_in));
    let remainder = t_amount_in - total_in_paid;
    let rem_real = remainder != 0;
    let rem_real_f = rem_real as Field;
    assert(remainder_live == rem_real_f);
    // bind the witnessed remainder amount/price (gated): amount == leftover, same price ratio.
    assert(rem_real_f * (rem_amount_in - remainder) == 0);
    assert(rem_real_f * (rem_min_out * t_amount_in - t_min_out * rem_amount_in) == 0);
    let rem_leaf = build_order_leaf(
        t_asset_in,
        rem_amount_in,
        t_asset_out,
        rem_min_out,
        t_out_tag,
        t_cancel_tag,
        t_expiry,
        t_partial,
    );
    assert(remainder_order_leaf == rem_real_f * rem_leaf);
}
