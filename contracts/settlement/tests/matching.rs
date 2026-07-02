//! Matching-engine corner-case tests that drive the REAL `submit_order` code path (genuine UltraHonk
//! verify + genuine Poseidon tree) against SYNTHETIC resting books. The book fixtures only ship four
//! order proofs (S1/S2/S3 sells, B1 buy), but the *taker* half of a match is all that needs a proof:
//! the maker half is plaintext book state. So we shield the fixtures' four input notes (to publish the
//! root R4 the proofs were made against), pre-seed the opposing book side with hand-built
//! `OrderEntry`s (exactly as scripts/07's worst-case test does), then submit one real taker proof and
//! assert the resulting fills, book state, and — most importantly — value conservation.
//!
//! Pair: base = asset 1 (a1), quote = asset 2 (a2). B1 = BUY (offer 2400 a2, want >=100 a1, price 24,
//! output tag 9011). S1 = SELL (offer 100 a1, want >=1500 a2, price 15, output tag 9001). Both
//! partial_allowed. Every scenario checks that, per asset, `minted-out + still-locked-in-book` equals
//! what was locked at submit (taker.amount_in + makers' remaining_in) — nothing created or destroyed.

use settlement::{
    AssetInit, AssetKind, DataKey, OrderEntry, PairDef, Settlement, SettlementClient,
};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::StellarAssetClient,
    vec,
    xdr::{ContractEventBody, Int128Parts, ScVal},
    Address, Bytes, BytesN, Env, Vec,
};

const VK: &[u8] = include_bytes!("fixtures/book/vk");
const CANCEL_VK: &[u8] = include_bytes!("fixtures/book/cancel_vk");

const P_B1: &[u8] = include_bytes!("fixtures/book/proof_b1");
const PI_B1: &[u8] = include_bytes!("fixtures/book/public_inputs_b1");
const P_S1: &[u8] = include_bytes!("fixtures/book/proof_s1");
const PI_S1: &[u8] = include_bytes!("fixtures/book/public_inputs_s1");

const OT_S1: &[u8] = include_bytes!("fixtures/book/owner_tag_s1");
const OT_S2: &[u8] = include_bytes!("fixtures/book/owner_tag_s2");
const OT_B1: &[u8] = include_bytes!("fixtures/book/owner_tag_b1");
const OT_S3: &[u8] = include_bytes!("fixtures/book/owner_tag_s3");

const A1: u32 = 1; // base
const A2: u32 = 2; // quote
const SIDE_BUY: u32 = 0;
const SIDE_SELL: u32 = 1;
const B1_TAG: u32 = 9011; // B1's output_owner_tag (proceeds + refund destination)
const S1_TAG: u32 = 9001; // S1's output_owner_tag
const NOW: u64 = 1000;
const FAR: u64 = 9999999999; // expiry well beyond NOW

fn test_env() -> Env {
    let env = Env::default();
    env.ledger().set_protocol_version(26);
    env.ledger().set_timestamp(NOW);
    env.cost_estimate().budget().reset_unlimited();
    env.mock_all_auths();
    env
}

fn bytes(env: &Env, b: &[u8]) -> Bytes {
    Bytes::from_slice(env, b)
}
fn tag(env: &Env, b: &[u8]) -> BytesN<32> {
    BytesN::from_array(env, &b.try_into().unwrap())
}
/// 32-byte big-endian field word holding a small integer tag in its low 4 bytes.
fn tag_word(n: u32) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[28..32].copy_from_slice(&n.to_be_bytes());
    w
}

/// Register asset `id` as a funded `Dual` SAC with `amount` minted to a fresh holder.
fn fund(env: &Env, asset_id: u32, amount: i128) -> (AssetInit, Address) {
    let sac = env.register_stellar_asset_contract_v2(Address::generate(env));
    let holder = Address::generate(env);
    StellarAssetClient::new(env, &sac.address()).mint(&holder, &amount);
    (
        AssetInit {
            asset_id,
            token: Some(sac.address()),
            kind: AssetKind::Dual,
        },
        holder,
    )
}

/// Deploy with the two assets + the canonical a1/a2 pair, then shield the fixtures' four input notes
/// so the tree reaches R4 (the root all four order proofs were generated against).
fn setup(env: &Env) -> Address {
    let (a1, h1) = fund(env, A1, 250);
    let (a2, h2) = fund(env, A2, 2400);
    let admin = Address::generate(env);
    let id = env.register(
        Settlement,
        (
            bytes(env, VK),
            bytes(env, VK),
            bytes(env, CANCEL_VK),
            bytes(env, VK),
            admin,
            vec![env, a1, a2],
            vec![
                env,
                PairDef {
                    base_asset: A1,
                    quote_asset: A2,
                },
            ],
        ),
    );
    let client = SettlementClient::new(env, &id);
    client.shield(&h1, &A1, &100, &tag(env, OT_S1));
    client.shield(&h1, &A1, &100, &tag(env, OT_S2));
    client.shield(&h2, &A2, &2400, &tag(env, OT_B1));
    client.shield(&h1, &A1, &50, &tag(env, OT_S3));
    id
}

/// Build a synthetic resting maker entry. `id_tag` is used both as the order id and the cancel tag;
/// `out_tag` is where its proceeds go. `remaining_in` defaults to `amount_in` (freshly rested).
fn maker(
    env: &Env,
    id_tag: u32,
    amount_in: i128,
    min_out: i128,
    out_tag: u32,
    partial: bool,
    expiry: u64,
) -> OrderEntry {
    OrderEntry {
        order_id: BytesN::from_array(env, &tag_word(id_tag)),
        amount_in,
        min_out,
        remaining_in: amount_in,
        output_owner_tag: BytesN::from_array(env, &tag_word(out_tag)),
        cancel_owner_tag: BytesN::from_array(env, &tag_word(id_tag + 1)),
        order_leaf: BytesN::from_array(env, &tag_word(id_tag + 2)),
        expiry,
        partial_allowed: partial,
    }
}

/// Overwrite one side of the book with `entries` (plaintext resting orders; no proofs needed).
fn seed_book(env: &Env, id: &Address, side: u32, entries: &[OrderEntry]) {
    env.as_contract(id, || {
        let mut v: Vec<OrderEntry> = Vec::new(env);
        for e in entries {
            v.push_back(e.clone());
        }
        env.storage().persistent().set(&DataKey::Book(0, side), &v);
    });
}

/// All `noteins` (minted asset-note) events in emission order, as (asset, amount, low-4-byte tag).
fn noteins(env: &Env) -> std::vec::Vec<(u32, i128, u32)> {
    let i128_of = |p: &Int128Parts| ((p.hi as i128) << 64) | (p.lo as i128);
    env.events()
        .all()
        .events()
        .iter()
        .filter_map(|e| {
            let ContractEventBody::V0(v0) = &e.body;
            match v0.topics.first() {
                Some(ScVal::Symbol(s)) if s.to_string() == "noteins" => match v0.data.clone() {
                    ScVal::Vec(Some(v)) => match (&v[0], &v[1], &v[2]) {
                        (ScVal::U32(a), ScVal::I128(amt), ScVal::Bytes(ot)) => {
                            let tail = u32::from_be_bytes(ot.0[28..32].try_into().unwrap());
                            Some((*a, i128_of(amt), tail))
                        }
                        _ => None,
                    },
                    _ => None,
                },
                _ => None,
            }
        })
        .collect()
}

/// The single `filled` taker-summary event (asset_in, amount_in, asset_out, amount_out), if any.
fn filled(env: &Env) -> Option<(u32, i128, u32, i128)> {
    let i128_of = |p: &Int128Parts| ((p.hi as i128) << 64) | (p.lo as i128);
    env.events()
        .all()
        .events()
        .iter()
        .find_map(|e| {
            let ContractEventBody::V0(v0) = &e.body;
            match v0.topics.first() {
                Some(ScVal::Symbol(s)) if s.to_string() == "filled" => match v0.data.clone() {
                    ScVal::Vec(Some(v)) => match (&v[0], &v[1], &v[2], &v[3]) {
                        (ScVal::U32(ai), ScVal::I128(ain), ScVal::U32(ao), ScVal::I128(aout)) => {
                            Some((*ai, i128_of(ain), *ao, i128_of(aout)))
                        }
                        _ => None,
                    },
                    _ => None,
                },
                _ => None,
            }
        })
}

/// A sorted multiset of the minted notes for order-independent comparison.
fn sorted(mut v: std::vec::Vec<(u32, i128, u32)>) -> std::vec::Vec<(u32, i128, u32)> {
    v.sort();
    v
}

/// Sum of `remaining_in` on a book side for a given asset-in (a1 for SELL, a2 for BUY).
fn locked_on(client: &SettlementClient, side: u32) -> i128 {
    client.book(&0, &side).iter().map(|e| e.remaining_in).sum()
}

// ---------------------------------------------------------------------------------------------------
// B1 BUY taker (offer 2400 a2, want >=100 a1) against synthetic SELL makers.
// ---------------------------------------------------------------------------------------------------

#[test]
fn b1_fully_fills_single_maker_at_its_price() {
    // One ask exactly at B1's limit (100 a1 @ 2400 a2, price 24): B1 sweeps it whole.
    let env = test_env();
    let id = setup(&env);
    seed_book(&env, &id, SIDE_SELL, &[maker(&env, 7001, 100, 2400, 7001, true, FAR)]);
    let client = SettlementClient::new(&env, &id);
    client.submit_order(&bytes(&env, P_B1), &bytes(&env, PI_B1));

    // Taker gets 100 a1; maker gets 2400 a2. Nothing rests.
    assert_eq!(
        sorted(noteins(&env)),
        sorted(std::vec![(A1, 100, B1_TAG), (A2, 2400, 7001)])
    );
    assert_eq!(filled(&env), Some((A2, 2400, A1, 100)));
    assert!(client.book(&0, &SIDE_SELL).is_empty(), "ask fully consumed");
    assert!(client.book(&0, &SIDE_BUY).is_empty(), "nothing rests");
    // Conservation. a2: locked 2400 = 2400 to maker + 0 resting. a1: maker's 100 -> 100 to taker.
    assert_eq!(2400, 2400 + locked_on(&client, SIDE_BUY));
}

#[test]
fn b1_takes_price_improvement_and_rests_remainder() {
    // Ask below B1's limit (100 a1 @ 1200 a2, price 12): B1 buys 100 a1 for only 1200 a2, then rests
    // the unspent 1200 a2 as a new bid (limit orders keep working at their own price).
    let env = test_env();
    let id = setup(&env);
    seed_book(&env, &id, SIDE_SELL, &[maker(&env, 7001, 100, 1200, 7001, true, FAR)]);
    let client = SettlementClient::new(&env, &id);
    client.submit_order(&bytes(&env, P_B1), &bytes(&env, PI_B1));

    assert_eq!(
        sorted(noteins(&env)),
        sorted(std::vec![(A1, 100, B1_TAG), (A2, 1200, 7001)])
    );
    assert_eq!(filled(&env), Some((A2, 1200, A1, 100)));
    assert!(client.book(&0, &SIDE_SELL).is_empty());
    let bids = client.book(&0, &SIDE_BUY);
    assert_eq!(bids.len(), 1, "B1 remainder rests as a bid");
    assert_eq!(bids.get(0).unwrap().remaining_in, 1200, "unspent 1200 a2");
    // Conservation a2: locked 2400 = 1200 to maker + 1200 resting bid.
    assert_eq!(2400, 1200 + locked_on(&client, SIDE_BUY));
}

#[test]
fn b1_does_not_cross_a_too_expensive_ask_and_rests_whole() {
    // Ask above B1's limit (100 a1 @ 2500 a2, price 25 > 24): no cross, B1 rests its full 2400 a2.
    let env = test_env();
    let id = setup(&env);
    seed_book(&env, &id, SIDE_SELL, &[maker(&env, 7001, 100, 2500, 7001, true, FAR)]);
    let client = SettlementClient::new(&env, &id);
    client.submit_order(&bytes(&env, P_B1), &bytes(&env, PI_B1));

    assert!(noteins(&env).is_empty(), "no fills => no mints");
    assert_eq!(filled(&env), None, "no fill event");
    assert_eq!(
        client.book(&0, &SIDE_SELL).get(0).unwrap().remaining_in,
        100,
        "ask untouched"
    );
    assert_eq!(locked_on(&client, SIDE_BUY), 2400, "whole taker rests");
}

#[test]
fn b1_skips_nonpartial_maker_it_cannot_consume_whole() {
    // A fill-or-nothing ask twice B1's size (200 a1 @ 4800 a2, price 24, partial=false). B1 can only
    // afford 100 of its 200 lots, so it must NOT partially fill it — the maker is skipped intact.
    let env = test_env();
    let id = setup(&env);
    seed_book(
        &env,
        &id,
        SIDE_SELL,
        &[maker(&env, 7001, 200, 4800, 7001, false, FAR)],
    );
    let client = SettlementClient::new(&env, &id);
    client.submit_order(&bytes(&env, P_B1), &bytes(&env, PI_B1));

    assert!(noteins(&env).is_empty(), "no partial fill of a fill-or-nothing maker");
    assert_eq!(
        client.book(&0, &SIDE_SELL).get(0).unwrap().remaining_in,
        200,
        "non-partial ask untouched"
    );
    assert_eq!(locked_on(&client, SIDE_BUY), 2400, "B1 rests whole");
}

#[test]
fn b1_skips_expired_maker_then_fills_the_live_one() {
    // Best-priced ask is expired; the loop must skip it (leaving it for prune) and fill the next live
    // ask. Order in book is [expired@15, live@24]; only the live one trades.
    let env = test_env();
    let id = setup(&env);
    seed_book(
        &env,
        &id,
        SIDE_SELL,
        &[
            maker(&env, 7001, 100, 1500, 7001, true, 500), // expired (500 < NOW)
            maker(&env, 7010, 100, 2400, 7010, true, FAR), // live @ price 24
        ],
    );
    let client = SettlementClient::new(&env, &id);
    client.submit_order(&bytes(&env, P_B1), &bytes(&env, PI_B1));

    assert_eq!(
        sorted(noteins(&env)),
        sorted(std::vec![(A1, 100, B1_TAG), (A2, 2400, 7010)]),
        "only the live ask fills"
    );
    let asks = client.book(&0, &SIDE_SELL);
    assert_eq!(asks.len(), 1, "expired ask left resting for prune");
    assert_eq!(asks.get(0).unwrap().order_id.to_array(), tag_word(7001));
    assert!(client.book(&0, &SIDE_BUY).is_empty());
}

#[test]
fn b1_honours_price_time_priority_across_equal_price_makers() {
    // Two asks at the same price 24; B1 has exactly enough for one. FIFO => the FIRST-seeded maker
    // (7001) trades, the second (7010) is left intact.
    let env = test_env();
    let id = setup(&env);
    seed_book(
        &env,
        &id,
        SIDE_SELL,
        &[
            maker(&env, 7001, 100, 2400, 7001, true, FAR),
            maker(&env, 7010, 100, 2400, 7010, true, FAR),
        ],
    );
    let client = SettlementClient::new(&env, &id);
    client.submit_order(&bytes(&env, P_B1), &bytes(&env, PI_B1));

    assert_eq!(
        sorted(noteins(&env)),
        sorted(std::vec![(A1, 100, B1_TAG), (A2, 2400, 7001)]),
        "the earlier equal-price maker fills first"
    );
    let asks = client.book(&0, &SIDE_SELL);
    assert_eq!(asks.len(), 1);
    assert_eq!(asks.get(0).unwrap().order_id.to_array(), tag_word(7010));
}

#[test]
fn b1_refunds_sub_lot_dust_instead_of_resting() {
    // Ask price 12 sized so B1 spends 2388 a2 (199 lots) and is left with 12 a2 < its own 24-a2 lot.
    // A sub-lot remainder can never match again, so it is refunded, not rested.
    let env = test_env();
    let id = setup(&env);
    seed_book(&env, &id, SIDE_SELL, &[maker(&env, 7001, 199, 2388, 7001, true, FAR)]);
    let client = SettlementClient::new(&env, &id);
    client.submit_order(&bytes(&env, P_B1), &bytes(&env, PI_B1));

    assert_eq!(
        sorted(noteins(&env)),
        sorted(std::vec![
            (A1, 199, B1_TAG),  // taker receives 199 a1
            (A2, 2388, 7001),   // maker receives 2388 a2
            (A2, 12, B1_TAG),   // 12 a2 dust refunded to the taker
        ])
    );
    assert!(client.book(&0, &SIDE_SELL).is_empty(), "maker fully consumed");
    assert!(
        client.book(&0, &SIDE_BUY).is_empty(),
        "dust is refunded, not rested"
    );
    // Conservation a2: 2400 locked = 2388 to maker + 12 refunded + 0 resting.
    assert_eq!(2400, 2388 + 12 + locked_on(&client, SIDE_BUY));
}

#[test]
fn b1_ioc_refunds_remainder_when_its_own_side_is_full() {
    // Price-improving ask leaves B1 with 1200 a2 that WOULD rest, but the bid side is already at the
    // 64-order capacity. So the remainder is immediate-or-cancel refunded instead of rested.
    let env = test_env();
    let id = setup(&env);
    // Fill the bid side to capacity (64 dummy non-crossing bids @ price 1, they never match here).
    let mut full: std::vec::Vec<OrderEntry> = std::vec::Vec::new();
    for n in 0..64u32 {
        full.push(maker(&env, 8000 + n * 4, 1, 1, 8000 + n * 4, true, FAR));
    }
    seed_book(&env, &id, SIDE_BUY, &full);
    seed_book(&env, &id, SIDE_SELL, &[maker(&env, 7001, 100, 1200, 7001, true, FAR)]);
    let client = SettlementClient::new(&env, &id);
    client.submit_order(&bytes(&env, P_B1), &bytes(&env, PI_B1));

    assert_eq!(
        sorted(noteins(&env)),
        sorted(std::vec![
            (A1, 100, B1_TAG),   // taker fill
            (A2, 1200, 7001),    // maker fill
            (A2, 1200, B1_TAG),  // remainder IOC-refunded (book full)
        ])
    );
    assert_eq!(
        client.book(&0, &SIDE_BUY).len(),
        64,
        "bid side stays at capacity; B1 did not rest"
    );
    assert!(client.book(&0, &SIDE_SELL).is_empty());
}

#[test]
fn b1_fills_at_most_max_fills_then_rests() {
    // Six tiny crossing asks (10 a1 @ 240 a2, price 24). B1 may fill at most MAX_FILLS_PER_SUBMIT (4)
    // per submit; the remaining two asks stay, and B1 rests the still-unspent quote.
    let env = test_env();
    let id = setup(&env);
    let mut asks: std::vec::Vec<OrderEntry> = std::vec::Vec::new();
    for n in 0..6u32 {
        asks.push(maker(&env, 7000 + n * 4, 10, 240, 7000 + n * 4, true, FAR));
    }
    seed_book(&env, &id, SIDE_SELL, &asks);
    let client = SettlementClient::new(&env, &id);
    client.submit_order(&bytes(&env, P_B1), &bytes(&env, PI_B1));

    // 4 fills: taker gets 4*10 = 40 a1; each maker gets 240 a2 (4 maker notes). Remainder rests.
    let mints = noteins(&env);
    let taker_a1: i128 = mints
        .iter()
        .filter(|(a, _, t)| *a == A1 && *t == B1_TAG)
        .map(|(_, amt, _)| *amt)
        .sum();
    assert_eq!(taker_a1, 40, "4 fills * 10 a1");
    let maker_a2_notes = mints.iter().filter(|(a, _, t)| *a == A2 && *t != B1_TAG).count();
    assert_eq!(maker_a2_notes, 4, "one 240-a2 note per filled maker");
    assert_eq!(
        client.book(&0, &SIDE_SELL).len(),
        2,
        "only 4 of 6 asks consumed (MAX_FILLS cap)"
    );
    // Conservation a2: 2400 = 4*240 to makers + resting bid remainder.
    assert_eq!(2400, 4 * 240 + locked_on(&client, SIDE_BUY));
}

// ---------------------------------------------------------------------------------------------------
// S1 SELL taker (offer 100 a1, want >=1500 a2) against a synthetic BUY maker — exercises the mirror
// (maker_is_sell = false) branch of the fill loop.
// ---------------------------------------------------------------------------------------------------

#[test]
fn s1_sell_taker_fills_against_a_buy_maker() {
    // Bid @ price 30 (offer 3000 a2, want >=100 a1). S1 asks 15, so it crosses and sells its 100 a1
    // for the bid's full 3000 a2 (price improvement for the taker).
    let env = test_env();
    let id = setup(&env);
    seed_book(&env, &id, SIDE_BUY, &[maker(&env, 7001, 3000, 100, 7001, true, FAR)]);
    let client = SettlementClient::new(&env, &id);
    client.submit_order(&bytes(&env, P_S1), &bytes(&env, PI_S1));

    assert_eq!(
        sorted(noteins(&env)),
        sorted(std::vec![(A2, 3000, S1_TAG), (A1, 100, 7001)]),
        "taker receives 3000 a2; maker receives 100 a1"
    );
    assert_eq!(filled(&env), Some((A1, 100, A2, 3000)));
    assert!(client.book(&0, &SIDE_BUY).is_empty(), "bid fully consumed");
    assert!(client.book(&0, &SIDE_SELL).is_empty(), "taker fully filled");
    // Conservation a1: taker locked 100 -> 100 to maker. a2: maker locked 3000 -> 3000 to taker.
    assert_eq!(100, 100 + locked_on(&client, SIDE_SELL));
}
