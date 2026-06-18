//! Integration test for the atomic settlement flow, run entirely in the local Soroban host (no
//! testnet). The native BN254 host functions the UltraHonk verifier needs are part of the test
//! `Env`, so verification is REAL, not mocked.
//!
//! Fixtures in tests/fixtures/ are real bb artifacts for the `circuits/lift` order circuit:
//!   - order A: offer 100 of asset 1, want >= 1500 of asset 2 (tags 0x2329 / 0x232a)
//!   - order B: offer 2000 of asset 2, want >= 50 of asset 1 (tags 0x2333 / 0x2334)
//! A and B cross, so `settle` matches them in one atomic two-verify transaction. Regenerate with
//! tests/fixtures/regen.sh.

use settlement::{Error, Settlement, SettlementClient};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env, String,
};

const VK: &[u8] = include_bytes!("fixtures/vk");
const PROOF_A: &[u8] = include_bytes!("fixtures/proof_a");
const PI_A: &[u8] = include_bytes!("fixtures/public_inputs_a");
const PROOF_B: &[u8] = include_bytes!("fixtures/proof_b");
const PI_B: &[u8] = include_bytes!("fixtures/public_inputs_b");

// Unshield circuit fixtures (asset note spend -> token payout). The proof binds `recipient` to
// UNSHIELD_TO below; regenerate both together (see fixtures/regen.sh).
const UNSHIELD_VK: &[u8] = include_bytes!("fixtures/unshield_vk");
const UNSHIELD_PROOF: &[u8] = include_bytes!("fixtures/unshield_proof");
const UNSHIELD_PI: &[u8] = include_bytes!("fixtures/unshield_public_inputs");
// The payout address the unshield proof's `recipient` field commits to (a fixed test address).
const UNSHIELD_TO: &str = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const UNSHIELD_OP: u32 = 2;
const UNSHIELD_AMOUNT: i128 = 100;

// Public-input word index for the membership root (see docs/lift-circuit-spec.md).
const W_ROOT: usize = 1;
const W_AMOUNT_IN: usize = 4;

fn test_env() -> Env {
    let env = Env::default();
    env.ledger().set_protocol_version(26);
    env.cost_estimate().budget().reset_unlimited();
    env.mock_all_auths();
    env
}

/// Register the settlement contract with the order (lift) VK and a generated admin.
fn deploy(env: &Env) -> (Address, Address) {
    let admin = Address::generate(env);
    let vk = Bytes::from_slice(env, VK);
    let id = env.register(Settlement, (vk, admin.clone()));
    (id, admin)
}

fn bytes(env: &Env, b: &[u8]) -> Bytes {
    Bytes::from_slice(env, b)
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

// ===========================================================================
// Happy path: settle two crossing orders atomically (both proofs verified in one tx).
// ===========================================================================

#[test]
fn settle_two_crossing_orders() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);

    push_root(&client, &env, PI_A);
    push_root(&client, &env, PI_B);

    client.settle(
        &bytes(&env, PROOF_A),
        &bytes(&env, PI_A),
        &bytes(&env, PROOF_B),
        &bytes(&env, PI_B),
    );

    // Exactly one settled event from this contract. Its proceeds are stamped from each order's
    // bound output_owner_tag (derived from the verified public inputs).
    assert_eq!(env.events().all().filter_by_contract(&id).events().len(), 1);

    // Both consumed-note nullifiers are now recorded: re-settling the same pair is rejected.
    let err = env
        .as_contract(&id, || {
            Settlement::settle(
                env.clone(),
                bytes(&env, PROOF_A),
                bytes(&env, PI_A),
                bytes(&env, PROOF_B),
                bytes(&env, PI_B),
            )
        })
        .expect_err("replayed settle");
    assert_eq!(err as u32, Error::NullifierUsed as u32);
}

// ===========================================================================
// Negative cases for settle.
// ===========================================================================

#[test]
fn settle_rejects_unpublished_root() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    // Both proofs verify, but no root was published.
    let err = env
        .as_contract(&id, || {
            Settlement::settle(
                env.clone(),
                bytes(&env, PROOF_A),
                bytes(&env, PI_A),
                bytes(&env, PROOF_B),
                bytes(&env, PI_B),
            )
        })
        .expect_err("unpublished root");
    assert_eq!(err as u32, Error::UnknownRoot as u32);
}

#[test]
fn settle_rejects_tampered_order_field() {
    // The proof binds every order field: a valid proof with a tampered amount_in fails to verify,
    // so a matcher cannot substitute order terms.
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    push_root(&client, &env, PI_A);
    push_root(&client, &env, PI_B);

    let mut tampered = PI_A.to_vec();
    tampered[W_AMOUNT_IN * 32 + 31] ^= 0x01;

    let err = env
        .as_contract(&id, || {
            Settlement::settle(
                env.clone(),
                bytes(&env, PROOF_A),
                Bytes::from_slice(&env, &tampered),
                bytes(&env, PROOF_B),
                bytes(&env, PI_B),
            )
        })
        .expect_err("tampered order field");
    assert_eq!(err as u32, Error::VerificationFailed as u32);
}

#[test]
fn settle_rejects_wrong_public_input_length() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let short = &PI_A[..PI_A.len() - 32]; // 9 words instead of 10
    let err = env
        .as_contract(&id, || {
            Settlement::settle(
                env.clone(),
                bytes(&env, PROOF_A),
                bytes(&env, short),
                bytes(&env, PROOF_B),
                bytes(&env, PI_B),
            )
        })
        .expect_err("short public inputs");
    assert_eq!(err as u32, Error::BadPublicInputs as u32);
}

#[test]
fn settle_rejects_incompatible_orders() {
    // Order A against itself does not cross (A offers asset 1 / wants asset 2, so asset_in != the
    // other side's asset_out). Both proofs verify; the crossing check rejects.
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    push_root(&client, &env, PI_A);

    let err = env
        .as_contract(&id, || {
            Settlement::settle(
                env.clone(),
                bytes(&env, PROOF_A),
                bytes(&env, PI_A),
                bytes(&env, PROOF_A),
                bytes(&env, PI_A),
            )
        })
        .expect_err("incompatible / self-pair");
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
// Unshield: spend an asset note with a proof and pay the bound recipient.
// ===========================================================================

/// Deploy, register the unshield VK, fund custody with the asset, publish the proof's root, and
/// return (token, bound recipient address).
fn setup_unshield(env: &Env, id: &Address) -> (Address, Address) {
    let token_admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token = sac.address();
    // Fund custody so the contract can pay out.
    StellarAssetClient::new(env, &token).mint(id, &1000);

    let client = SettlementClient::new(env, id);
    client.register_asset(&ASSET_ID, &token);
    client.set_vk(&UNSHIELD_OP, &bytes(env, UNSHIELD_VK));
    client.push_root(&bytesn_at(env, UNSHIELD_PI, W_ROOT));

    let to = Address::from_string(&String::from_str(env, UNSHIELD_TO));
    (token, to)
}

#[test]
fn unshield_pays_bound_recipient() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let (token, to) = setup_unshield(&env, &id);

    SettlementClient::new(&env, &id).unshield(
        &to,
        &bytes(&env, UNSHIELD_PROOF),
        &bytes(&env, UNSHIELD_PI),
    );

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&to), UNSHIELD_AMOUNT);
    assert_eq!(token_client.balance(&id), 1000 - UNSHIELD_AMOUNT);

    // The spend nullifier is recorded: replaying the same proof is rejected.
    let err = env
        .as_contract(&id, || {
            Settlement::unshield(
                env.clone(),
                to.clone(),
                bytes(&env, UNSHIELD_PROOF),
                bytes(&env, UNSHIELD_PI),
            )
        })
        .expect_err("replayed unshield");
    assert_eq!(err as u32, Error::NullifierUsed as u32);
}

#[test]
fn unshield_rejects_wrong_recipient() {
    // A relayer cannot redirect: paying anyone other than the proof-bound recipient fails.
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let (_token, _to) = setup_unshield(&env, &id);
    let attacker = Address::generate(&env);

    let err = env
        .as_contract(&id, || {
            Settlement::unshield(
                env.clone(),
                attacker.clone(),
                bytes(&env, UNSHIELD_PROOF),
                bytes(&env, UNSHIELD_PI),
            )
        })
        .expect_err("redirected payout");
    assert_eq!(err as u32, Error::RecipientMismatch as u32);
}

#[test]
fn unshield_rejects_unpublished_root() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    // Register the VK but do NOT push the root.
    SettlementClient::new(&env, &id).set_vk(&UNSHIELD_OP, &bytes(&env, UNSHIELD_VK));
    let to = Address::from_string(&String::from_str(&env, UNSHIELD_TO));

    let err = env
        .as_contract(&id, || {
            Settlement::unshield(
                env.clone(),
                to.clone(),
                bytes(&env, UNSHIELD_PROOF),
                bytes(&env, UNSHIELD_PI),
            )
        })
        .expect_err("unpublished root");
    assert_eq!(err as u32, Error::UnknownRoot as u32);
}

#[test]
fn unshield_rejects_missing_vk() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    // No set_vk(UNSHIELD_OP): the order VK alone cannot verify an unshield proof.
    let to = Address::from_string(&String::from_str(&env, UNSHIELD_TO));
    let err = env
        .as_contract(&id, || {
            Settlement::unshield(
                env.clone(),
                to.clone(),
                bytes(&env, UNSHIELD_PROOF),
                bytes(&env, UNSHIELD_PI),
            )
        })
        .expect_err("missing unshield vk");
    assert_eq!(err as u32, Error::VkNotSet as u32);
}

// ===========================================================================
// Budget sanity. Local host metering UNDER-counts relative to on-chain calibration
// (local ~55M/verify vs the authoritative testnet ~81M, see docs/milestone-0-results.md),
// so this is a regression guard, not the real budget number: it confirms an atomic
// two-verify settle stays well within the 400M per-tx budget.
// ===========================================================================

#[test]
fn settle_fits_cpu_budget() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    push_root(&client, &env, PI_A);
    push_root(&client, &env, PI_B);

    env.cost_estimate().budget().reset_unlimited();
    client.settle(
        &bytes(&env, PROOF_A),
        &bytes(&env, PI_A),
        &bytes(&env, PROOF_B),
        &bytes(&env, PI_B),
    );
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();
    std::println!("atomic settle (two verifies) CPU instructions (local host): {cpu}");

    // 400M is the per-transaction Soroban budget; two verifies must fit in one tx.
    assert!(
        cpu < 400_000_000,
        "settle CPU {cpu} exceeds the 400M per-tx budget"
    );
}
