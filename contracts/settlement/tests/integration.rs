//! Integration test for the full verify-at-lift / proof-free-settle flow, run entirely in the
//! local Soroban host (no testnet). The native BN254 host functions the UltraHonk verifier needs
//! are part of the test `Env`, so verification is REAL, not mocked.
//!
//! Fixtures in tests/fixtures/ are real bb artifacts for the `circuits/lift` circuit:
//!   - order A: offer 100 of asset 1, want >= 1500 of asset 2 (tags 0x2329 / 0x232a)
//!   - order B: offer 2000 of asset 2, want >= 50 of asset 1 (tags 0x2333 / 0x2334)
//! A and B cross, so settle matches them. Regenerate with tests/fixtures/regen.sh.

use settlement::{DataKey, Error, PoolEntry, Settlement, SettlementClient};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env,
};

const VK: &[u8] = include_bytes!("fixtures/vk");
const PROOF_A: &[u8] = include_bytes!("fixtures/proof_a");
const PI_A: &[u8] = include_bytes!("fixtures/public_inputs_a");
const PROOF_B: &[u8] = include_bytes!("fixtures/proof_b");
const PI_B: &[u8] = include_bytes!("fixtures/public_inputs_b");

// Public-input word indices (see docs/lift-circuit-spec.md).
const W_ROOT: usize = 1;
const W_ASSET_IN: usize = 3;
const W_AMOUNT_IN: usize = 4;
const W_ASSET_OUT: usize = 5;
const W_MIN_OUT: usize = 6;
const W_OUT_TAG: usize = 7;

fn test_env() -> Env {
    let env = Env::default();
    env.ledger().set_protocol_version(26);
    env.cost_estimate().budget().reset_unlimited();
    env.mock_all_auths();
    env
}

/// Register the settlement contract with the lift VK and a generated admin.
fn deploy(env: &Env) -> (Address, Address) {
    let admin = Address::generate(env);
    let vk = Bytes::from_slice(env, VK);
    let id = env.register(Settlement, (vk, admin.clone()));
    (id, admin)
}

fn bytes(env: &Env, b: &[u8]) -> Bytes {
    Bytes::from_slice(env, b)
}

fn u32_at(pi: &[u8], word: usize) -> u32 {
    let o = word * 32;
    u32::from_be_bytes([pi[o + 28], pi[o + 29], pi[o + 30], pi[o + 31]])
}

fn i128_at(pi: &[u8], word: usize) -> i128 {
    let o = word * 32;
    let mut b = [0u8; 16];
    b.copy_from_slice(&pi[o + 16..o + 32]);
    i128::from_be_bytes(b)
}

fn bytesn_at(env: &Env, pi: &[u8], word: usize) -> BytesN<32> {
    let o = word * 32;
    let mut a = [0u8; 32];
    a.copy_from_slice(&pi[o..o + 32]);
    BytesN::from_array(env, &a)
}

/// Publish the membership root carried in a public-input blob.
fn push_root(client: &SettlementClient, env: &Env, pi: &[u8]) {
    client.push_root(&bytesn_at(env, pi, W_ROOT));
}

fn read_entry(env: &Env, id: &Address, entry_id: u32) -> PoolEntry {
    env.as_contract(id, || {
        env.storage()
            .persistent()
            .get::<DataKey, PoolEntry>(&DataKey::Entry(entry_id))
            .expect("entry stored")
    })
}

// ===========================================================================
// Happy path: lift two crossing orders, then settle them with no proof.
// ===========================================================================

#[test]
fn full_flow_lift_then_settle() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);

    push_root(&client, &env, PI_A);
    push_root(&client, &env, PI_B);

    client.lift(&1, &bytes(&env, PROOF_A), &bytes(&env, PI_A));
    client.lift(&2, &bytes(&env, PROOF_B), &bytes(&env, PI_B));

    // settle succeeds and crosses the two bound orders.
    client.settle(&1, &2);

    // Exactly one settled event is emitted. Its proceeds descriptors are stamped from each order's
    // stored output_owner_tag, which `lift_stores_fields_derived_from_proof` proves equals the
    // proof's bound public input — so settle's outputs are bound by construction.
    assert_eq!(env.events().all().events().len(), 1);

    // Both orders are now consumed.
    assert!(read_entry(&env, &id, 1).consumed);
    assert!(read_entry(&env, &id, 2).consumed);

    // Re-settling the same pair is rejected.
    let err = env
        .as_contract(&id, || Settlement::settle(env.clone(), 1, 2))
        .expect_err("double settle");
    assert_eq!(err as u32, Error::AlreadyConsumed as u32);
}

// ===========================================================================
// lift binds every order field to the proof (the core soundness property).
// ===========================================================================

#[test]
fn lift_stores_fields_derived_from_proof() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);

    push_root(&client, &env, PI_A);
    client.lift(&1, &bytes(&env, PROOF_A), &bytes(&env, PI_A));

    // Every stored field must equal the verified public input, not anything a caller chose
    // (the lift entrypoint takes no order arguments at all).
    let e = read_entry(&env, &id, 1);
    assert_eq!(e.asset_in, u32_at(PI_A, W_ASSET_IN));
    assert_eq!(e.amount_in, i128_at(PI_A, W_AMOUNT_IN));
    assert_eq!(e.asset_out, u32_at(PI_A, W_ASSET_OUT));
    assert_eq!(e.min_out, i128_at(PI_A, W_MIN_OUT));
    assert_eq!(e.output_owner_tag, bytesn_at(&env, PI_A, W_OUT_TAG));
    assert!(!e.consumed);
}

// ===========================================================================
// Negative cases.
// ===========================================================================

#[test]
fn lift_rejects_unpublished_root() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    // No push_root: the membership root is unknown.
    let err = env
        .as_contract(&id, || {
            Settlement::lift(env.clone(), 1, bytes(&env, PROOF_A), bytes(&env, PI_A))
        })
        .expect_err("unpublished root");
    assert_eq!(err as u32, Error::UnknownRoot as u32);
}

#[test]
fn lift_rejects_replayed_nullifier() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    push_root(&client, &env, PI_A);

    client.lift(&1, &bytes(&env, PROOF_A), &bytes(&env, PI_A));

    // Same proof again (same consumed-note nullifier) must be rejected, even at a new entry id.
    let err = env
        .as_contract(&id, || {
            Settlement::lift(env.clone(), 5, bytes(&env, PROOF_A), bytes(&env, PI_A))
        })
        .expect_err("replayed nullifier");
    assert_eq!(err as u32, Error::NullifierUsed as u32);
}

#[test]
fn lift_rejects_tampered_order_field() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    push_root(&client, &env, PI_A);

    // Flip the low byte of amount_in (word 4) while keeping the original valid proof.
    // The proof binds amount_in, so verification must fail.
    let mut tampered = PI_A.to_vec();
    let o = W_AMOUNT_IN * 32;
    tampered[o + 31] ^= 0x01;

    let err = env
        .as_contract(&id, || {
            Settlement::lift(
                env.clone(),
                1,
                bytes(&env, PROOF_A),
                Bytes::from_slice(&env, &tampered),
            )
        })
        .expect_err("tampered order field");
    assert_eq!(err as u32, Error::VerificationFailed as u32);
}

#[test]
fn lift_rejects_wrong_public_input_length() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    // 9 words instead of 10.
    let short = &PI_A[..PI_A.len() - 32];
    let err = env
        .as_contract(&id, || {
            Settlement::lift(env.clone(), 1, bytes(&env, PROOF_A), bytes(&env, short))
        })
        .expect_err("short public inputs");
    assert_eq!(err as u32, Error::BadPublicInputs as u32);
}

#[test]
fn settle_rejects_incompatible_orders() {
    // Two A-orders do not cross (both offer asset 1, want asset 2).
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    push_root(&client, &env, PI_A);

    client.lift(&1, &bytes(&env, PROOF_A), &bytes(&env, PI_A));
    // A second order with the same shape requires a distinct nullifier; reuse is blocked, so we
    // assert on the only A-proof we have by lifting it once and pairing it with itself.
    let err = env
        .as_contract(&id, || Settlement::settle(env.clone(), 1, 1))
        .expect_err("self-pair is incompatible");
    assert_eq!(err as u32, Error::NotCompatible as u32);
}

// ===========================================================================
// Custody: shield moves a real token into the contract and mints an AssetNote.
// ===========================================================================

const ASSET_ID: u32 = 1;
const TAG: [u8; 32] = [0xAB; 32];

/// Register a Stellar Asset Contract, mint `amount` to a fresh user, and map it to ASSET_ID.
fn setup_token(env: &Env, id: &Address, amount: i128) -> (Address, Address) {
    let token_admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token = sac.address();
    let user = Address::generate(env);
    StellarAssetClient::new(env, &token).mint(&user, &amount);

    let client = SettlementClient::new(env, id);
    client.register_asset(&ASSET_ID, &token);
    (token, user)
}

#[test]
fn shield_moves_tokens_into_custody() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let (token, user) = setup_token(&env, &id, 100);
    let client = SettlementClient::new(&env, &id);
    let tag = BytesN::from_array(&env, &TAG);

    client.shield(&user, &ASSET_ID, &100, &tag);

    // A shielded event announced the new AssetNote for the off-chain tree builder. Filter to this
    // contract (the token transfer emits its own event), and check first: env.events() reflects the
    // latest invocation, and the balance reads below are cross-contract calls that replace the view.
    assert_eq!(env.events().all().filter_by_contract(&id).events().len(), 1);

    // Tokens left the user and now sit in the contract's custody.
    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&user), 0);
    assert_eq!(token_client.balance(&id), 100);
}

#[test]
fn shield_rejects_unregistered_asset() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let user = Address::generate(&env);
    let tag = BytesN::from_array(&env, &TAG);
    let err = env
        .as_contract(&id, || {
            Settlement::shield(env.clone(), user.clone(), 99, 100, tag.clone())
        })
        .expect_err("unregistered asset");
    assert_eq!(err as u32, Error::AssetNotRegistered as u32);
}

#[test]
fn shield_rejects_nonpositive_amount() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let (_token, user) = setup_token(&env, &id, 100);
    let tag = BytesN::from_array(&env, &TAG);
    let err = env
        .as_contract(&id, || {
            Settlement::shield(env.clone(), user.clone(), ASSET_ID, 0, tag.clone())
        })
        .expect_err("zero amount");
    assert_eq!(err as u32, Error::InvalidAmount as u32);
}

#[test]
fn register_asset_rejects_rebind() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let (_token, _user) = setup_token(&env, &id, 100);
    let other = Address::generate(&env);
    let err = env
        .as_contract(&id, || {
            Settlement::register_asset(env.clone(), ASSET_ID, other.clone())
        })
        .expect_err("rebind");
    assert_eq!(err as u32, Error::AssetAlreadyRegistered as u32);
}

// ===========================================================================
// Budget sanity. Local host metering UNDER-counts relative to on-chain calibration
// (local ~55M vs the authoritative testnet 81.16M, see docs/milestone-0-results.md),
// so this is a regression guard, not the real budget number: it just confirms lift
// stays well within one transaction.
// ===========================================================================

#[test]
fn lift_fits_cpu_budget() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    push_root(&client, &env, PI_A);

    env.cost_estimate().budget().reset_unlimited();
    client.lift(&1, &bytes(&env, PROOF_A), &bytes(&env, PI_A));
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();
    std::println!("lift CPU instructions (local host): {cpu}");

    // ~100M is the per-transaction Soroban budget. The lift must fit in one tx.
    assert!(
        cpu < 100_000_000,
        "lift CPU {cpu} exceeds the ~100M per-tx budget"
    );
}