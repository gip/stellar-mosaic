//! WS4 real-proof integration test for `join`: consolidate two same-asset notes into a target +
//! change note, entirely inside the shielded pool, on the local Soroban host (REAL BN254/Poseidon +
//! a REAL UltraHonk proof, no testnet). The per-note nonce + nullifier-IMT transition are proven
//! in-circuit; the contract only CAS-advances the accumulator and mints the bound outputs.
//!
//! Fixtures (tests/fixtures/ws4/, scenario C in regen.py):
//!   shield A=150 a1 (leaf 0), B=200 a1 (leaf 1) -> root R2
//!   join: consume A + B  ->  out_1 = 300 a1 (target) + out_2 = 50 a1 (change)   (150+200 == 300+50)
//! The join proof's membership root (public input [1]) is exactly R2, the root the two shields
//! produce on-chain. Input note secrets: A sk 0x31/rho 0x32, B sk 0x41/rho 0x42 (both nonce 0).

use mosaic_indexer::{u256_to_word, Hasher};
use settlement::{Error, Settlement, SettlementClient};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::StellarAssetClient,
    Address, Bytes, BytesN, Env, U256,
};

const LIFT_VK: &[u8] = include_bytes!("fixtures/ws4/lift_vk"); // constructor arg only (lift circuit)
const JOIN_VK: &[u8] = include_bytes!("fixtures/ws4/join_vk");
const JOIN_PROOF: &[u8] = include_bytes!("fixtures/ws4/join_proof");
const JOIN_PI: &[u8] = include_bytes!("fixtures/ws4/join_pi");

const ASSET_1: u32 = 1;
const AMOUNT_A: i128 = 150;
const AMOUNT_B: i128 = 200;
const JOIN_OP: u32 = 4;
// WS4 join public-input field indices (see the join circuit / contract `join`).
const W_OUT_AMOUNT_1: usize = 8;
const W_OUT_AMOUNT_2: usize = 10;

fn test_env() -> Env {
    let env = Env::default();
    env.ledger().set_protocol_version(26);
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

fn tag(env: &Env, b: &[u8; 32]) -> BytesN<32> {
    BytesN::from_array(env, b)
}

/// minted note owner tag = compress(compress(compress(sk,0),rho),nonce), matching the witness tool's
/// `notetagn` (the convention regen.py used to build the proof).
fn notetagn(env: &Env, h: &Hasher, sk: u128, rho: u128, nonce: u128) -> [u8; 32] {
    let pk = h.compress(env, &U256::from_u128(env, sk), &U256::from_u32(env, 0));
    let base = h.compress(env, &pk, &U256::from_u128(env, rho));
    u256_to_word(&h.compress(env, &base, &U256::from_u128(env, nonce)))
}

fn pi_word_i128(pi: &[u8], w: usize) -> i128 {
    i128::from_be_bytes(pi[w * 32 + 16..w * 32 + 32].try_into().unwrap())
}

/// Deploy, register the join VK + asset 1, and shield BOTH input notes (advancing the note tree to
/// R2, the root the join proof was built against). Returns the contract id.
fn setup(env: &Env) -> Address {
    let id = deploy(env);
    let client = SettlementClient::new(env, &id);
    client.set_vk(&JOIN_OP, &bytes(env, JOIN_VK));
    let h = Hasher::new(env);

    let token_admin = Address::generate(env);
    let token = env.register_stellar_asset_contract_v2(token_admin).address();
    let holder = Address::generate(env);
    StellarAssetClient::new(env, &token).mint(&holder, &(AMOUNT_A + AMOUNT_B));
    client.register_asset(&ASSET_1, &token);

    client.shield(&holder, &ASSET_1, &AMOUNT_A, &tag(env, &notetagn(env, &h, 0x31, 0x32, 0x0)));
    client.shield(&holder, &ASSET_1, &AMOUNT_B, &tag(env, &notetagn(env, &h, 0x41, 0x42, 0x0)));
    id
}

#[test]
fn join_consolidates_two_notes() {
    let env = test_env();
    let id = setup(&env);
    let client = SettlementClient::new(&env, &id);

    // Conservation is visible in the (verified) public inputs: out_1 + out_2 == A + B.
    assert_eq!(
        pi_word_i128(JOIN_PI, W_OUT_AMOUNT_1) + pi_word_i128(JOIN_PI, W_OUT_AMOUNT_2),
        AMOUNT_A + AMOUNT_B,
        "join public inputs must conserve value",
    );

    let root_before = client.root();
    client.join(&bytes(&env, JOIN_PROOF), &bytes(&env, JOIN_PI));

    // Read events immediately: each subsequent contract call (e.g. `root()`) resets the buffer.
    // The join announced itself with two `nfspent`, two `noteins` (target + change), and one `joined`.
    let events = env.events().all().filter_by_contract(&id).events().len();
    assert_eq!(events, 5, "join emits 2 nfspent + 2 noteins + joined");

    // The two fresh notes were inserted, so the tree root advanced.
    assert_ne!(client.root(), root_before, "two output notes inserted");
}

#[test]
fn join_records_nullifiers_no_replay() {
    let env = test_env();
    let id = setup(&env);
    SettlementClient::new(&env, &id).join(&bytes(&env, JOIN_PROOF), &bytes(&env, JOIN_PI));

    // The accumulator advanced past the proof's nullifier_root_in, so replaying the same join hits
    // the CAS check (stale root_in) and is rejected.
    let err = env
        .as_contract(&id, || {
            Settlement::join(env.clone(), bytes(&env, JOIN_PROOF), bytes(&env, JOIN_PI))
        })
        .expect_err("replayed join");
    assert_eq!(err as u32, Error::NullifierUsed as u32);
}

#[test]
fn join_rejects_unknown_root() {
    // Register the VK but never shield, so R2 was never produced on-chain. The proof still verifies,
    // but its membership root is not in the published history.
    let env = test_env();
    let id = deploy(&env);
    SettlementClient::new(&env, &id).set_vk(&JOIN_OP, &bytes(&env, JOIN_VK));

    let err = env
        .as_contract(&id, || {
            Settlement::join(env.clone(), bytes(&env, JOIN_PROOF), bytes(&env, JOIN_PI))
        })
        .expect_err("unknown root");
    assert_eq!(err as u32, Error::UnknownRoot as u32);
}

#[test]
fn join_rejects_tampered_output_amount() {
    // The proof binds every output field: flipping a bit in out_amount_1 fails verification (the
    // contract would otherwise mint a forged, non-conserving amount).
    let env = test_env();
    let id = setup(&env);
    let mut tampered = JOIN_PI.to_vec();
    tampered[W_OUT_AMOUNT_1 * 32 + 31] ^= 0x01;

    let err = env
        .as_contract(&id, || {
            Settlement::join(env.clone(), bytes(&env, JOIN_PROOF), Bytes::from_slice(&env, &tampered))
        })
        .expect_err("tampered output amount");
    assert_eq!(err as u32, Error::VerificationFailed as u32);
}

#[test]
fn join_rejects_wrong_public_input_length() {
    let env = test_env();
    let id = setup(&env);
    let short = &JOIN_PI[..JOIN_PI.len() - 32];

    let err = env
        .as_contract(&id, || {
            Settlement::join(env.clone(), bytes(&env, JOIN_PROOF), bytes(&env, short))
        })
        .expect_err("short public inputs");
    assert_eq!(err as u32, Error::BadPublicInputs as u32);
}

#[test]
fn join_rejects_missing_vk() {
    // Asset registered + notes shielded (root accepted), but the join VK was never set.
    let env = test_env();
    let id = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    let h = Hasher::new(&env);
    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(token_admin).address();
    let holder = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&holder, &(AMOUNT_A + AMOUNT_B));
    client.register_asset(&ASSET_1, &token);
    client.shield(&holder, &ASSET_1, &AMOUNT_A, &tag(&env, &notetagn(&env, &h, 0x31, 0x32, 0x0)));
    client.shield(&holder, &ASSET_1, &AMOUNT_B, &tag(&env, &notetagn(&env, &h, 0x41, 0x42, 0x0)));

    let err = env
        .as_contract(&id, || {
            Settlement::join(env.clone(), bytes(&env, JOIN_PROOF), bytes(&env, JOIN_PI))
        })
        .expect_err("missing join vk");
    assert_eq!(err as u32, Error::VkNotSet as u32);
}
