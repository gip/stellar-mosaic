//! WS4 integration tests on the local Soroban host with the REAL UltraHonk verifier. The happy paths
//! (shield -> place_order, and the full shield x2 -> place x2 -> settle_match) live in tests/ws4.rs;
//! this file covers the contract's structural rules (asset/pair registration, shield validation) and
//! the negative paths for place_order / settle_match / unshield. Proof fixtures are the real bb 0.87.0
//! artifacts in tests/fixtures/ws4/ (regenerate with `python3 tests/fixtures/ws4/regen.py`).
//!
//! Removed in WS4 (so their tests are gone): the atomic `settle`/`settle_exact` two-proof crossings
//! and the `Vec`-backed on-chain book — matching now happens in the `match` circuit + `settle_match`.

use mosaic_indexer::{u256_to_word, Hasher};
use settlement::{Error, Settlement, SettlementClient};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env, String, U256,
};

const LIFT_VK: &[u8] = include_bytes!("fixtures/ws4/lift_vk"); // op 1 vk, set at construction

// place_order (scenario A): shield 100 asset1 under NOTE_TAG, place order give 100 a1 / want >=1500 a2.
const PLACE_PROOF: &[u8] = include_bytes!("fixtures/ws4/place_proof");
const PLACE_PI: &[u8] = include_bytes!("fixtures/ws4/place_public_inputs");
const NOTE_TAG: &[u8] = include_bytes!("fixtures/ws4/note_tag");

// settle_match (scenario B) artifacts — used here only for negative paths.
const MATCH_PROOF: &[u8] = include_bytes!("fixtures/ws4/match_proof");
const MATCH_PI: &[u8] = include_bytes!("fixtures/ws4/match_pi");
const MATCH_VK: &[u8] = include_bytes!("fixtures/ws4/match_vk");

// unshield (scenario D): shield 100 asset1, spend it to UNSHIELD_TO (recipient bound in-proof).
const UNSHIELD_VK: &[u8] = include_bytes!("fixtures/ws4/unshield_vk");
const UNSHIELD_PROOF: &[u8] = include_bytes!("fixtures/ws4/unshield_proof");
const UNSHIELD_PI: &[u8] = include_bytes!("fixtures/ws4/unshield_pi");
const UNSHIELD_TO: &str = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

const ASSET_1: u32 = 1;
const ASSET_2: u32 = 2;
const AMOUNT_IN: i128 = 100; // place/unshield note: 100 of asset 1
const LIFT_OP: u32 = 1;
const UNSHIELD_OP: u32 = 2;
const MATCH_OP: u32 = 5;
const W_AMOUNT_IN: usize = 6; // lift PI [6] = amount_in
const W_NOW: usize = 4; // match PI [4] = now (also exercises a verified field for tampering)

fn test_env() -> Env {
    let env = Env::default();
    env.ledger().set_protocol_version(26);
    env.ledger().set_timestamp(100); // within the order's expiry window (expiry 1000, TTL 7d)
    env.cost_estimate().budget().reset_unlimited();
    env.mock_all_auths();
    env
}

fn deploy(env: &Env) -> Address {
    let admin = Address::generate(env);
    env.register(Settlement, (Bytes::from_slice(env, LIFT_VK), admin))
}

fn bytes(env: &Env, b: &[u8]) -> Bytes {
    Bytes::from_slice(env, b)
}

fn tag(env: &Env, b: &[u8]) -> BytesN<32> {
    BytesN::from_array(env, &b.try_into().unwrap())
}

/// minted note owner tag = compress(compress(compress(sk,0),rho),nonce), matching `notetagn`.
fn notetagn(env: &Env, h: &Hasher, sk: u128, rho: u128, nonce: u128) -> [u8; 32] {
    let pk = h.compress(env, &U256::from_u128(env, sk), &U256::from_u32(env, 0));
    let base = h.compress(env, &pk, &U256::from_u128(env, rho));
    u256_to_word(&h.compress(env, &base, &U256::from_u128(env, nonce)))
}

/// Register a Stellar Asset Contract for `asset_id`, mint `amount` to a fresh holder, return both.
fn register_funded_asset(env: &Env, id: &Address, asset_id: u32, amount: i128) -> (Address, Address) {
    let token_admin = Address::generate(env);
    let token = env.register_stellar_asset_contract_v2(token_admin).address();
    let holder = Address::generate(env);
    StellarAssetClient::new(env, &token).mint(&holder, &amount);
    SettlementClient::new(env, id).register_asset(&asset_id, &token);
    (token, holder)
}

// ===========================================================================
// Asset + pair registration rules.
// ===========================================================================

#[test]
fn register_pair_assigns_ids_and_rejects_noncanonical() {
    let env = test_env();
    let id = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    register_funded_asset(&env, &id, ASSET_1, AMOUNT_IN);
    register_funded_asset(&env, &id, ASSET_2, AMOUNT_IN);

    // First pair gets id 0.
    assert_eq!(client.register_pair(&ASSET_1, &ASSET_2), 0);

    // The reverse orientation is the SAME market and is rejected.
    let err = env
        .as_contract(&id, || Settlement::register_pair(env.clone(), ASSET_2, ASSET_1))
        .expect_err("reverse orientation");
    assert_eq!(err as u32, Error::PairAlreadyRegistered as u32);

    // Re-registering the same orientation is rejected too.
    let err = env
        .as_contract(&id, || Settlement::register_pair(env.clone(), ASSET_1, ASSET_2))
        .expect_err("duplicate pair");
    assert_eq!(err as u32, Error::PairAlreadyRegistered as u32);
}

#[test]
fn register_pair_rejects_unregistered_asset_and_self_pair() {
    let env = test_env();
    let id = deploy(&env);
    register_funded_asset(&env, &id, ASSET_1, AMOUNT_IN);

    // ASSET_2 not registered.
    let err = env
        .as_contract(&id, || Settlement::register_pair(env.clone(), ASSET_1, ASSET_2))
        .expect_err("unregistered quote asset");
    assert_eq!(err as u32, Error::AssetNotRegistered as u32);

    // base == quote is not a pair.
    let err = env
        .as_contract(&id, || Settlement::register_pair(env.clone(), ASSET_1, ASSET_1))
        .expect_err("self pair");
    assert_eq!(err as u32, Error::PairNotRegistered as u32);
}

#[test]
fn register_asset_rejects_rebind() {
    let env = test_env();
    let id = deploy(&env);
    register_funded_asset(&env, &id, ASSET_1, AMOUNT_IN);
    let other = Address::generate(&env);
    let err = env
        .as_contract(&id, || Settlement::register_asset(env.clone(), ASSET_1, other.clone()))
        .expect_err("rebind");
    assert_eq!(err as u32, Error::AssetAlreadyRegistered as u32);
}

// ===========================================================================
// Shield custody + validation.
// ===========================================================================

#[test]
fn shield_moves_tokens_into_custody_and_advances_root() {
    let env = test_env();
    let id = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    let (token, holder) = register_funded_asset(&env, &id, ASSET_1, AMOUNT_IN);

    let root_before = client.root();
    client.shield(&holder, &ASSET_1, &AMOUNT_IN, &tag(&env, NOTE_TAG));

    // The shielded event announced the note; check before the cross-contract balance reads.
    assert_eq!(env.events().all().filter_by_contract(&id).events().len(), 1);
    assert_ne!(client.root(), root_before, "a leaf was inserted");

    let tc = TokenClient::new(&env, &token);
    assert_eq!(tc.balance(&holder), 0);
    assert_eq!(tc.balance(&id), AMOUNT_IN);
}

#[test]
fn shield_rejects_unregistered_asset() {
    let env = test_env();
    let id = deploy(&env);
    let user = Address::generate(&env);
    let err = env
        .as_contract(&id, || Settlement::shield(env.clone(), user.clone(), 99, 100, tag(&env, NOTE_TAG)))
        .expect_err("unregistered asset");
    assert_eq!(err as u32, Error::AssetNotRegistered as u32);
}

#[test]
fn shield_rejects_nonpositive_amount() {
    let env = test_env();
    let id = deploy(&env);
    let (_t, holder) = register_funded_asset(&env, &id, ASSET_1, AMOUNT_IN);
    let err = env
        .as_contract(&id, || Settlement::shield(env.clone(), holder.clone(), ASSET_1, 0, tag(&env, NOTE_TAG)))
        .expect_err("zero amount");
    assert_eq!(err as u32, Error::InvalidAmount as u32);
}

// ===========================================================================
// place_order negatives (happy path: tests/ws4.rs::shield_then_place_order_real_proof).
// ===========================================================================

/// Deploy, register the pair (1->2), and shield the order's input note (advancing the tree to the
/// root the place proof was built against). Returns the contract id.
fn setup_place(env: &Env) -> Address {
    let id = deploy(env);
    let client = SettlementClient::new(env, &id);
    let (_t1, holder) = register_funded_asset(env, &id, ASSET_1, AMOUNT_IN);
    register_funded_asset(env, &id, ASSET_2, AMOUNT_IN);
    client.register_pair(&ASSET_1, &ASSET_2);
    client.shield(&holder, &ASSET_1, &AMOUNT_IN, &tag(env, NOTE_TAG));
    id
}

#[test]
fn place_order_rejects_unknown_root() {
    // Pair registered but the input note never shielded, so the proof's note_root is not published.
    let env = test_env();
    let id = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    register_funded_asset(&env, &id, ASSET_1, AMOUNT_IN);
    register_funded_asset(&env, &id, ASSET_2, AMOUNT_IN);
    client.register_pair(&ASSET_1, &ASSET_2);

    let err = env
        .as_contract(&id, || Settlement::place_order(env.clone(), bytes(&env, PLACE_PROOF), bytes(&env, PLACE_PI)))
        .expect_err("unknown note root");
    assert_eq!(err as u32, Error::UnknownRoot as u32);
}

#[test]
fn place_order_records_nullifier_no_replay() {
    let env = test_env();
    let id = setup_place(&env);
    SettlementClient::new(&env, &id).place_order(&bytes(&env, PLACE_PROOF), &bytes(&env, PLACE_PI));

    // The accumulator advanced past the proof's nullifier_root_in; replaying hits the CAS check.
    let err = env
        .as_contract(&id, || Settlement::place_order(env.clone(), bytes(&env, PLACE_PROOF), bytes(&env, PLACE_PI)))
        .expect_err("replayed place_order");
    assert_eq!(err as u32, Error::NullifierUsed as u32);
}

#[test]
fn place_order_rejects_tampered_field() {
    // Flipping a bit in the bound amount_in fails verification (the order leaf would otherwise bind a
    // forged amount).
    let env = test_env();
    let id = setup_place(&env);
    let mut tampered = PLACE_PI.to_vec();
    tampered[W_AMOUNT_IN * 32 + 31] ^= 0x01;

    let err = env
        .as_contract(&id, || Settlement::place_order(env.clone(), bytes(&env, PLACE_PROOF), Bytes::from_slice(&env, &tampered)))
        .expect_err("tampered amount_in");
    assert_eq!(err as u32, Error::VerificationFailed as u32);
}

#[test]
fn place_order_rejects_wrong_public_input_length() {
    let env = test_env();
    let id = setup_place(&env);
    let short = &PLACE_PI[..PLACE_PI.len() - 32];
    let err = env
        .as_contract(&id, || Settlement::place_order(env.clone(), bytes(&env, PLACE_PROOF), bytes(&env, short)))
        .expect_err("short public inputs");
    assert_eq!(err as u32, Error::BadPublicInputs as u32);
}

// ===========================================================================
// settle_match negatives (happy path: tests/ws4.rs::full_flow_shield_place_place_settle_match).
// ===========================================================================

#[test]
fn settle_match_rejects_missing_vk() {
    // Lengths are valid, but the match (op 5) VK was never registered.
    let env = test_env();
    let id = deploy(&env);
    let err = env
        .as_contract(&id, || Settlement::settle_match(env.clone(), bytes(&env, MATCH_PROOF), bytes(&env, MATCH_PI)))
        .expect_err("missing match vk");
    assert_eq!(err as u32, Error::VkNotSet as u32);
}

#[test]
fn settle_match_rejects_tampered_field() {
    let env = test_env();
    let id = deploy(&env);
    SettlementClient::new(&env, &id).set_vk(&MATCH_OP, &bytes(&env, MATCH_VK));
    let mut tampered = MATCH_PI.to_vec();
    tampered[W_NOW * 32 + 31] ^= 0x01;

    let err = env
        .as_contract(&id, || Settlement::settle_match(env.clone(), bytes(&env, MATCH_PROOF), Bytes::from_slice(&env, &tampered)))
        .expect_err("tampered match field");
    assert_eq!(err as u32, Error::VerificationFailed as u32);
}

#[test]
fn settle_match_rejects_unknown_order_root() {
    // The proof verifies, but no orders were placed, so its bound order_root is not in the history.
    let env = test_env();
    let id = deploy(&env);
    SettlementClient::new(&env, &id).set_vk(&MATCH_OP, &bytes(&env, MATCH_VK));

    let err = env
        .as_contract(&id, || Settlement::settle_match(env.clone(), bytes(&env, MATCH_PROOF), bytes(&env, MATCH_PI)))
        .expect_err("unknown order root");
    assert_eq!(err as u32, Error::UnknownRoot as u32);
}

#[test]
fn settle_match_rejects_wrong_public_input_length() {
    let env = test_env();
    let id = deploy(&env);
    let short = &MATCH_PI[..MATCH_PI.len() - 32];
    let err = env
        .as_contract(&id, || Settlement::settle_match(env.clone(), bytes(&env, MATCH_PROOF), bytes(&env, short)))
        .expect_err("short match public inputs");
    assert_eq!(err as u32, Error::BadPublicInputs as u32);
}

// ===========================================================================
// unshield: spend a note to the proof-bound recipient.
// ===========================================================================

/// Deploy, register the unshield VK + asset 1, and shield the unshield note (funds custody +
/// advances the tree to the root the proof was made against). Returns (token, bound recipient).
fn setup_unshield(env: &Env) -> (Address, Address, Address) {
    let id = deploy(env);
    let client = SettlementClient::new(env, &id);
    let (token, holder) = register_funded_asset(env, &id, ASSET_1, AMOUNT_IN);
    client.set_vk(&UNSHIELD_OP, &bytes(env, UNSHIELD_VK));
    let h = Hasher::new(env);
    // The unshield note's owner tag (sk 0x71 / rho 0x72 / nonce 0), the secret regen.py proved over.
    client.shield(&holder, &ASSET_1, &AMOUNT_IN, &tag(env, &notetagn(env, &h, 0x71, 0x72, 0x0)));
    let to = Address::from_string(&String::from_str(env, UNSHIELD_TO));
    (id, token, to)
}

#[test]
fn unshield_pays_bound_recipient() {
    let env = test_env();
    let (id, token, to) = setup_unshield(&env);

    SettlementClient::new(&env, &id).unshield(&to, &bytes(&env, UNSHIELD_PROOF), &bytes(&env, UNSHIELD_PI));

    let tc = TokenClient::new(&env, &token);
    assert_eq!(tc.balance(&to), AMOUNT_IN);
    assert_eq!(tc.balance(&id), 0);

    // Replaying the same proof is rejected (the accumulator advanced past its nullifier_root_in).
    let err = env
        .as_contract(&id, || Settlement::unshield(env.clone(), to.clone(), bytes(&env, UNSHIELD_PROOF), bytes(&env, UNSHIELD_PI)))
        .expect_err("replayed unshield");
    assert_eq!(err as u32, Error::NullifierUsed as u32);
}

#[test]
fn unshield_rejects_wrong_recipient() {
    let env = test_env();
    let (id, _token, _to) = setup_unshield(&env);
    let attacker = Address::generate(&env);

    let err = env
        .as_contract(&id, || Settlement::unshield(env.clone(), attacker.clone(), bytes(&env, UNSHIELD_PROOF), bytes(&env, UNSHIELD_PI)))
        .expect_err("redirected payout");
    assert_eq!(err as u32, Error::RecipientMismatch as u32);
}

#[test]
fn unshield_rejects_unknown_root() {
    // VK registered but the note never shielded, so its membership root is not published.
    let env = test_env();
    let id = deploy(&env);
    SettlementClient::new(&env, &id).set_vk(&UNSHIELD_OP, &bytes(&env, UNSHIELD_VK));
    let to = Address::from_string(&String::from_str(&env, UNSHIELD_TO));

    let err = env
        .as_contract(&id, || Settlement::unshield(env.clone(), to.clone(), bytes(&env, UNSHIELD_PROOF), bytes(&env, UNSHIELD_PI)))
        .expect_err("unknown root");
    assert_eq!(err as u32, Error::UnknownRoot as u32);
}

#[test]
fn unshield_rejects_missing_vk() {
    let env = test_env();
    let id = deploy(&env);
    let to = Address::from_string(&String::from_str(&env, UNSHIELD_TO));
    let err = env
        .as_contract(&id, || Settlement::unshield(env.clone(), to.clone(), bytes(&env, UNSHIELD_PROOF), bytes(&env, UNSHIELD_PI)))
        .expect_err("missing unshield vk");
    assert_eq!(err as u32, Error::VkNotSet as u32);
}
