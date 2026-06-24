//! Wire-format lock for the contract's WS4 events.
//!
//! The events are the cross-chain/indexer contract: consumers (tools/indexer, backend/src/indexer.rs)
//! parse a single Symbol topic + a positional data Vec. This pins exactly that: for each event it
//! compares the `#[contractevent]` value's topics+data (as `ScVal`) against the expected `(symbol,)`
//! topic and the expected positional field tuple. If the macro's encoding ever drifts (e.g.
//! data_format flips to a map, or a field is reordered), this fails instead of silently breaking the
//! indexer's `parse_*` readers. WS4 removed the WS1 `settled`/`filled` events; the surface is now
//! shielded / noteins / orderins / nfspent / unshield / joined / matched.

use settlement::{
    Joined, Matched, NoteInserted, NullifierSpent, OrderInserted, Shielded, Unshielded,
};
use soroban_sdk::{symbol_short, xdr::ScVal, BytesN, Env, Event, FromVal, IntoVal, Symbol, Val, Vec};

fn scval(env: &Env, v: Val) -> ScVal {
    ScVal::from_val(env, &v)
}

/// Assert `ev` emits exactly: topics == `(topic,)` and data == `want_data` (the expected tuple Val),
/// byte-for-byte (compared as `ScVal`).
fn assert_wire<E: Event>(env: &Env, ev: &E, topic: Symbol, want_data: Val) {
    let want_topics: Vec<Val> = (topic,).into_val(env);
    assert_eq!(
        scval(env, ev.topics(env).to_val()),
        scval(env, want_topics.to_val()),
        "topic mismatch",
    );
    assert_eq!(scval(env, ev.data(env)), scval(env, want_data), "data mismatch");
}

fn tag(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

#[test]
fn shielded_and_noteins_wire_format() {
    let env = Env::default();
    let t = tag(&env, 0x11);

    // A user shield and an internal mint share a shape, distinct topics.
    assert_wire(
        &env,
        &Shielded { asset_id: 1, amount: 100, owner_tag: t.clone() },
        symbol_short!("shielded"),
        (1u32, 100i128, t.clone()).into_val(&env),
    );
    assert_wire(
        &env,
        &NoteInserted { asset: 2, amount: 2000, owner_tag: t.clone() },
        symbol_short!("noteins"),
        (2u32, 2000i128, t).into_val(&env),
    );
}

#[test]
fn orderins_wire_format() {
    let env = Env::default();
    let (otag, ctag, leaf) = (tag(&env, 0xA1), tag(&env, 0xA2), tag(&env, 0xA3));
    // Full public order terms + leaf, in the order indexer::parse_orderins decodes them.
    assert_wire(
        &env,
        &OrderInserted {
            asset_in: 1,
            amount_in: 100,
            asset_out: 2,
            min_out: 1500,
            output_owner_tag: otag.clone(),
            cancel_owner_tag: ctag.clone(),
            expiry: 1000,
            partial_allowed: true,
            order_leaf: leaf.clone(),
        },
        symbol_short!("orderins"),
        (1u32, 100i128, 2u32, 1500i128, otag, ctag, 1000u64, true, leaf).into_val(&env),
    );
}

#[test]
fn nfspent_and_matched_wire_format() {
    let env = Env::default();
    let (nf, root) = (tag(&env, 0x07), tag(&env, 0x09));
    assert_wire(
        &env,
        &NullifierSpent { nullifier: nf.clone() },
        symbol_short!("nfspent"),
        (nf,).into_val(&env),
    );
    assert_wire(
        &env,
        &Matched { nullifier_root_out: root.clone() },
        symbol_short!("matched"),
        (root,).into_val(&env),
    );
}

#[test]
fn unshield_and_joined_wire_format() {
    let env = Env::default();
    let (nf, nf1, nf2) = (tag(&env, 0x01), tag(&env, 0x02), tag(&env, 0x03));

    assert_wire(
        &env,
        &Unshielded { asset: 1, amount: 100, nullifier: nf.clone() },
        symbol_short!("unshield"),
        (1u32, 100i128, nf).into_val(&env),
    );
    assert_wire(
        &env,
        &Joined { asset: 1, nf1: nf1.clone(), nf2: nf2.clone() },
        symbol_short!("joined"),
        (1u32, nf1, nf2).into_val(&env),
    );
}
