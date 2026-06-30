//! Wire-format lock for the contract's events.
//!
//! The events are the cross-chain/indexer contract: consumers (tools/indexer, backend/src/indexer.rs)
//! parse a single Symbol topic + a positional data Vec. When these moved from the deprecated
//! `env.events().publish((symbol_short!(name),), (..tuple..))` form to `#[contractevent]` structs,
//! the emitted bytes had to stay IDENTICAL. This test pins exactly that: for each event it compares
//! the `#[contractevent]` value's topics+data (as `ScVal`) against the legacy `(symbol,)` topic and
//! the legacy field tuple. If the macro's encoding ever drifts (e.g. data_format flips to a map, or a
//! field is reordered), this fails instead of silently breaking the indexer.

use settlement::{
    AssetRegistered, BookInitialized, Filled, Joined, NoteInserted, OrderRemoved, OrderUpserted,
    PairRegistered, Settled, Shielded, Unshielded,
};
use soroban_sdk::{
    symbol_short, testutils::Address as _, xdr::ScVal, Address, BytesN, Env, Event, FromVal,
    IntoVal, Symbol, Val, Vec,
};

fn scval(env: &Env, v: Val) -> ScVal {
    ScVal::from_val(env, &v)
}

/// Assert `ev` emits exactly: topics == `(topic,)` and data == `want_data` (the legacy tuple Val),
/// byte-for-byte (compared as `ScVal`).
fn assert_wire<E: Event>(env: &Env, ev: &E, topic: Symbol, want_data: Val) {
    let want_topics: Vec<Val> = (topic,).into_val(env);
    assert_eq!(
        scval(env, ev.topics(env).to_val()),
        scval(env, want_topics.to_val()),
        "topic mismatch",
    );
    assert_eq!(
        scval(env, ev.data(env)),
        scval(env, want_data),
        "data mismatch"
    );
}

fn tag(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

#[test]
fn shielded_and_noteins_wire_format() {
    let env = Env::default();
    let t = tag(&env, 0x11);

    assert_wire(
        &env,
        &Shielded {
            asset_id: 1,
            amount: 100,
            owner_tag: t.clone(),
        },
        symbol_short!("shielded"),
        (1u32, 100i128, t.clone()).into_val(&env),
    );
    // Same shape, distinct topic.
    assert_wire(
        &env,
        &NoteInserted {
            asset: 2,
            amount: 2000,
            owner_tag: t.clone(),
        },
        symbol_short!("noteins"),
        (2u32, 2000i128, t).into_val(&env),
    );
}

#[test]
fn settled_wire_format() {
    let env = Env::default();
    let (ta, tb) = (tag(&env, 0xAA), tag(&env, 0xBB));
    assert_wire(
        &env,
        &Settled {
            a_asset_out: 2,
            b_amount_in: 2000,
            a_output_owner_tag: ta.clone(),
            b_asset_out: 1,
            a_amount_in: 100,
            b_output_owner_tag: tb.clone(),
        },
        symbol_short!("settled"),
        (2u32, 2000i128, ta, 1u32, 100i128, tb).into_val(&env),
    );
}

#[test]
fn unshield_and_joined_wire_format() {
    let env = Env::default();
    let (nf, nf1, nf2) = (tag(&env, 0x01), tag(&env, 0x02), tag(&env, 0x03));

    assert_wire(
        &env,
        &Unshielded {
            asset: 1,
            amount: 100,
            nullifier: nf.clone(),
        },
        symbol_short!("unshield"),
        (1u32, 100i128, nf).into_val(&env),
    );
    assert_wire(
        &env,
        &Joined {
            asset: 1,
            nf1: nf1.clone(),
            nf2: nf2.clone(),
        },
        symbol_short!("joined"),
        (1u32, nf1, nf2).into_val(&env),
    );
}

#[test]
fn filled_wire_format() {
    let env = Env::default();
    let t = tag(&env, 0x77);
    assert_wire(
        &env,
        &Filled {
            asset_in: 1,
            amount_in: 100,
            asset_out: 2,
            amount_out: 2000,
            output_owner_tag: t.clone(),
        },
        symbol_short!("filled"),
        (1u32, 100i128, 2u32, 2000i128, t).into_val(&env),
    );
}

#[test]
fn book_initialization_and_registry_wire_format() {
    let env = Env::default();
    let (a, b, c, d) = (tag(&env, 1), tag(&env, 2), tag(&env, 3), tag(&env, 4));
    assert_wire(
        &env,
        &BookInitialized {
            schema_version: 1,
            lift_vk_hash: a.clone(),
            unshield_vk_hash: b.clone(),
            cancel_vk_hash: c.clone(),
            join_vk_hash: d.clone(),
        },
        symbol_short!("bookinit"),
        (1u32, a, b, c, d).into_val(&env),
    );

    let token = Address::generate(&env);
    assert_wire(
        &env,
        &AssetRegistered {
            asset_id: 7,
            token: token.clone(),
            kind: 1,
        },
        symbol_short!("assetreg"),
        (7u32, token, 1u32).into_val(&env),
    );
    assert_wire(
        &env,
        &PairRegistered {
            pair_id: 3,
            base_asset: 7,
            quote_asset: 9,
        },
        symbol_short!("pairreg"),
        (3u32, 7u32, 9u32).into_val(&env),
    );
}

#[test]
fn book_delta_wire_format() {
    let env = Env::default();
    let (id, output, cancel, leaf) = (tag(&env, 1), tag(&env, 2), tag(&env, 3), tag(&env, 4));
    assert_wire(
        &env,
        &OrderUpserted {
            sequence: 11,
            pair_id: 2,
            side: 1,
            order_id: id.clone(),
            amount_in: 100,
            min_out: 1500,
            remaining_in: 44,
            output_owner_tag: output.clone(),
            cancel_owner_tag: cancel.clone(),
            order_leaf: leaf.clone(),
            expiry: 5000,
            partial_allowed: true,
        },
        symbol_short!("ordupsert"),
        (
            11u64,
            2u32,
            1u32,
            id.clone(),
            100i128,
            1500i128,
            44i128,
            output,
            cancel,
            leaf,
            5000u64,
            true,
        )
            .into_val(&env),
    );
    assert_wire(
        &env,
        &OrderRemoved {
            sequence: 12,
            pair_id: 2,
            side: 1,
            order_id: id.clone(),
            reason: 1,
        },
        symbol_short!("ordremove"),
        (12u64, 2u32, 1u32, id, 1u32).into_val(&env),
    );
}
