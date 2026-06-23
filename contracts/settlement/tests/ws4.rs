//! WS4 real-proof integration test: shield -> place_order, on the local Soroban host with the REAL
//! UltraHonk verifier and a proof whose witnesses (note path + per-note nonce + nullifier-IMT insert)
//! were reconstructed by tools/indexer's `witness` bin. It validates that:
//!   - the contract's `imt_genesis_root` agrees byte-for-byte with the indexer's IMT genesis (so the
//!     proof's `nullifier_root_in` matches the fresh contract),
//!   - the note root the proof was built against matches the on-chain note tree after the shield,
//!   - place_order verifies the real proof, advances the nullifier accumulator by the note-spend
//!     nullifier, and appends the bound order leaf to the order tree.
//!
//! Fixtures (tests/fixtures/ws4/) are real bb 0.87.0 artifacts; regenerate with the scenario in this
//! file's header values (sk=0x11, rho_in=0x22, nonce_in=0x33, rho_out=0x44, rho_ord=0x55; order:
//! give 100 asset1, want >=1500 asset2; expiry 1000).

use mosaic_indexer::{
    order_consumption_nullifier, order_leaf, u256_to_word, word_to_u256, Hasher, NoteTree,
    NullifierImt,
};
use settlement::{Settlement, SettlementClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Bytes, BytesN, Env, U256,
};

const LIFT_VK: &[u8] = include_bytes!("fixtures/ws4/lift_vk");
const PLACE_PROOF: &[u8] = include_bytes!("fixtures/ws4/place_proof");
const PLACE_PI: &[u8] = include_bytes!("fixtures/ws4/place_public_inputs");
const NOTE_TAG: &[u8] = include_bytes!("fixtures/ws4/note_tag");

// Full-flow fixtures (shield x2 -> place x2 -> settle_match), see scratchpad gen_flow.py.
const TK_PLACE_PROOF: &[u8] = include_bytes!("fixtures/ws4/tk_place_proof");
const TK_PLACE_PI: &[u8] = include_bytes!("fixtures/ws4/tk_place_pi");
const MK_PLACE_PROOF: &[u8] = include_bytes!("fixtures/ws4/mk_place_proof");
const MK_PLACE_PI: &[u8] = include_bytes!("fixtures/ws4/mk_place_pi");
const MATCH_PROOF: &[u8] = include_bytes!("fixtures/ws4/match_proof");
const MATCH_PI: &[u8] = include_bytes!("fixtures/ws4/match_pi");
const MATCH_VK: &[u8] = include_bytes!("fixtures/ws4/match_vk");

const ASSET_1: u32 = 1;
const ASSET_2: u32 = 2;
const MATCH_OP: u32 = 5;

fn bytes(env: &Env, b: &[u8]) -> Bytes {
    Bytes::from_slice(env, b)
}
fn tag(env: &Env, b: &[u8]) -> BytesN<32> {
    BytesN::from_array(env, &b.try_into().unwrap())
}

/// owner_tag = compress(compress(sk,0), rho), matching the witness tool's `notetag`.
fn notetag(env: &Env, h: &Hasher, sk: u128, rho: u128) -> [u8; 32] {
    let pk = h.compress(env, &U256::from_u128(env, sk), &U256::from_u32(env, 0));
    u256_to_word(&h.compress(env, &pk, &U256::from_u128(env, rho)))
}

/// note-spend nullifier = compress(sk, compress(rho, nonce)), matching `notenull`.
fn notenull(env: &Env, h: &Hasher, sk: u128, rho: u128, nonce: u128) -> U256 {
    let inner = h.compress(env, &U256::from_u128(env, rho), &U256::from_u128(env, nonce));
    h.compress(env, &U256::from_u128(env, sk), &inner)
}

/// minted note owner tag = compress(compress(compress(sk,0),rho),nonce), matching `notetagn`.
fn notetagn(env: &Env, h: &Hasher, sk: u128, rho: u128, nonce: u128) -> [u8; 32] {
    let pk = h.compress(env, &U256::from_u128(env, sk), &U256::from_u32(env, 0));
    let base = h.compress(env, &pk, &U256::from_u128(env, rho));
    u256_to_word(&h.compress(env, &base, &U256::from_u128(env, nonce)))
}

/// proceeds note tag = note_owner_tag(base, compress(match_id, slot)), match_id = taker order leaf.
fn proceeds_tag(env: &Env, h: &Hasher, base: &[u8; 32], match_id: &U256, slot: u32) -> [u8; 32] {
    let nonce = h.compress(env, match_id, &U256::from_u32(env, slot));
    u256_to_word(&h.compress(env, &word_to_u256(env, base), &nonce))
}

fn register_asset(env: &Env, id: &Address, asset: u32) -> Address {
    let token_admin = Address::generate(env);
    let token = env.register_stellar_asset_contract_v2(token_admin).address();
    SettlementClient::new(env, id).register_asset(&asset, &token);
    token
}

#[test]
fn shield_then_place_order_real_proof() {
    let env = Env::default();
    env.ledger().set_protocol_version(26);
    env.ledger().set_timestamp(100); // within the order's expiry window (expiry=1000, TTL=7d)
    env.cost_estimate().budget().reset_unlimited();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let id = env.register(Settlement, (bytes(&env, LIFT_VK), admin.clone()));
    let client = SettlementClient::new(&env, &id);
    let h = Hasher::new(&env);

    // Assets + the registered pair the order names (asset_in=1 -> asset_out=2).
    let token1 = register_asset(&env, &id, ASSET_1);
    register_asset(&env, &id, ASSET_2);
    client.register_pair(&ASSET_1, &ASSET_2);

    // imt_genesis_root agreement: a fresh contract's nullifier root must equal the indexer's IMT
    // genesis (= the proof's nullifier_root_in). If this is wrong, place_order's CAS would reject.
    let genesis_imt = NullifierImt::new(&env);
    assert_eq!(
        client.nullifier_root().to_array(),
        u256_to_word(&genesis_imt.root()),
        "contract imt_genesis_root must equal the indexer's IMT genesis"
    );

    // Shield the taker's input note (asset1, 100) with the proof-bound owner tag.
    let holder = Address::generate(&env);
    StellarAssetClient::new(&env, &token1).mint(&holder, &100);
    client.shield(&holder, &ASSET_1, &100, &tag(&env, NOTE_TAG));
    let mut note_tree = NoteTree::new(&env);
    note_tree.ingest_shielded(ASSET_1, 100, NOTE_TAG.try_into().unwrap());
    assert_eq!(
        client.root().to_array(),
        u256_to_word(&note_tree.root()),
        "note root == the root the lift proof was built against"
    );

    // Place the order with the REAL UltraHonk proof.
    client.place_order(&bytes(&env, PLACE_PROOF), &bytes(&env, PLACE_PI));

    // The accumulator advanced by exactly the consumed note-spend nullifier.
    let nf_note = notenull(&env, &h, 0x11, 0x22, 0x33);
    let mut nf_after = NullifierImt::new(&env);
    nf_after.insert(nf_note);
    assert_eq!(
        client.nullifier_root().to_array(),
        u256_to_word(&nf_after.root()),
        "place_order advanced the nullifier accumulator by the note-spend nullifier"
    );

    // The order leaf was appended to the order tree (book is event/tree-derived).
    let t_out = notetag(&env, &h, 0x11, 0x44);
    let t_can = notetag(&env, &h, 0x11, 0x55);
    let leaf = order_leaf(&env, &h, 1, 100, 2, 1500, &t_out, &t_can, 1000, true);
    let mut order_tree = NoteTree::new(&env);
    order_tree.insert_leaf(leaf);
    assert_eq!(
        client.order_root().to_array(),
        u256_to_word(&order_tree.root()),
        "order_root == off-chain order tree with the appended order leaf"
    );
}

#[test]
fn full_flow_shield_place_place_settle_match() {
    let env = Env::default();
    env.ledger().set_protocol_version(26);
    env.ledger().set_timestamp(100);
    env.cost_estimate().budget().reset_unlimited();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let id = env.register(Settlement, (bytes(&env, LIFT_VK), admin.clone()));
    let client = SettlementClient::new(&env, &id);
    client.set_vk(&MATCH_OP, &bytes(&env, MATCH_VK));
    let h = Hasher::new(&env);

    let token1 = register_asset(&env, &id, ASSET_1);
    let token2 = register_asset(&env, &id, ASSET_2);
    client.register_pair(&ASSET_1, &ASSET_2);

    // --- shield the taker's (100 asset1) and maker's (1600 asset2) input notes ---
    let t_note_tag = notetagn(&env, &h, 0x11, 0x22, 0x33);
    let m_note_tag = notetagn(&env, &h, 0xAA, 0xBB, 0xCC);
    let holder_t = Address::generate(&env);
    let holder_m = Address::generate(&env);
    StellarAssetClient::new(&env, &token1).mint(&holder_t, &100);
    StellarAssetClient::new(&env, &token2).mint(&holder_m, &1600);
    client.shield(&holder_t, &ASSET_1, &100, &tag(&env, &t_note_tag));
    client.shield(&holder_m, &ASSET_2, &1600, &tag(&env, &m_note_tag));
    let mut note_tree = NoteTree::new(&env);
    note_tree.ingest_shielded(ASSET_1, 100, &t_note_tag);
    note_tree.ingest_shielded(ASSET_2, 1600, &m_note_tag);
    assert_eq!(client.root().to_array(), u256_to_word(&note_tree.root()), "note root after shields");

    // --- place both orders (each consumes its note-spend nullifier) ---
    client.place_order(&bytes(&env, TK_PLACE_PROOF), &bytes(&env, TK_PLACE_PI));
    client.place_order(&bytes(&env, MK_PLACE_PROOF), &bytes(&env, MK_PLACE_PI));
    let t_out = notetag(&env, &h, 0x11, 0x44);
    let t_can = notetag(&env, &h, 0x11, 0x55);
    let m_out = notetag(&env, &h, 0xAA, 0xDD);
    let m_can = notetag(&env, &h, 0xAA, 0xEE);
    let t_leaf = order_leaf(&env, &h, 1, 100, 2, 1500, &t_out, &t_can, 1000, true);
    let m_leaf = order_leaf(&env, &h, 2, 1600, 1, 100, &m_out, &m_can, 1000, true);
    let mut order_tree = NoteTree::new(&env);
    order_tree.insert_leaf(t_leaf.clone());
    order_tree.insert_leaf(m_leaf.clone());
    assert_eq!(client.order_root().to_array(), u256_to_word(&order_tree.root()), "order root after places");

    // --- settle the match (taker fully filled vs maker; no remainder) ---
    client.settle_match(&bytes(&env, MATCH_PROOF), &bytes(&env, MATCH_PI));

    // proceeds minted: taker receives 1600 asset2, maker receives 100 asset1 (per-note nonce tags).
    let p0_tag = proceeds_tag(&env, &h, &t_out, &t_leaf, 0);
    let p1_tag = proceeds_tag(&env, &h, &m_out, &t_leaf, 1);
    note_tree.ingest_note(ASSET_2, 1600, &p0_tag);
    note_tree.ingest_note(ASSET_1, 100, &p1_tag);
    assert_eq!(
        client.root().to_array(),
        u256_to_word(&note_tree.root()),
        "note root after settle_match minted the two proceeds notes"
    );

    // accumulator advanced through all four consumptions: 2 note-spends + 2 order-consumptions.
    let mut imt = NullifierImt::new(&env);
    imt.insert(notenull(&env, &h, 0x11, 0x22, 0x33));
    imt.insert(notenull(&env, &h, 0xAA, 0xBB, 0xCC));
    imt.insert(order_consumption_nullifier(&env, &h, &t_leaf));
    imt.insert(order_consumption_nullifier(&env, &h, &m_leaf));
    assert_eq!(
        client.nullifier_root().to_array(),
        u256_to_word(&imt.root()),
        "nullifier accumulator advanced through 2 placements + the match's 2 consumptions"
    );

    // custody is unchanged by matching (it shuffles note ownership, moves no tokens).
    use soroban_sdk::token::TokenClient;
    assert_eq!(TokenClient::new(&env, &token1).balance(&id), 100);
    assert_eq!(TokenClient::new(&env, &token2).balance(&id), 1600);
}
