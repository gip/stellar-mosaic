//! Integration test for the atomic settlement flow over an ON-CHAIN Merkle tree, run entirely in
//! the local Soroban host (no testnet). The native BN254/Poseidon host functions are part of the
//! test `Env`, so verification AND the tree hashing are REAL, not mocked.
//!
//! Fixtures (tests/fixtures/) are real bb artifacts whose membership proofs are made against the
//! roots the on-chain tree actually produces:
//!   - order A: shield asset 1 amount 100 (owner_tag_a) at index 0
//!   - order B: shield asset 2 amount 2000 (owner_tag_b) at index 1  -> tree root R2
//!   A and B cross; both order proofs prove membership against R2.
//!   - unshield: shield asset 1 amount 100 (owner_tag_u) at index 0 -> root R_U; proof against R_U.
//! Regenerate with tests/fixtures/regen.sh.

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
const OTAG_A: &[u8] = include_bytes!("fixtures/owner_tag_a");
const OTAG_B: &[u8] = include_bytes!("fixtures/owner_tag_b");

// Exact-reverse fixtures (same circuit/VK): A sells 100 of asset 1 wanting EXACTLY 2000 of asset 2;
// B sells 2000 of asset 2 wanting EXACTLY 100 of asset 1. Notes shielded at leaf 0 (exa) / 1 (exb).
const PROOF_EXA: &[u8] = include_bytes!("fixtures/proof_exa");
const PI_EXA: &[u8] = include_bytes!("fixtures/public_inputs_exa");
const PROOF_EXB: &[u8] = include_bytes!("fixtures/proof_exb");
const PI_EXB: &[u8] = include_bytes!("fixtures/public_inputs_exb");
const OTAG_EXA: &[u8] = include_bytes!("fixtures/owner_tag_exa");
const OTAG_EXB: &[u8] = include_bytes!("fixtures/owner_tag_exb");

const UNSHIELD_VK: &[u8] = include_bytes!("fixtures/unshield_vk");
const UNSHIELD_PROOF: &[u8] = include_bytes!("fixtures/unshield_proof");
const UNSHIELD_PI: &[u8] = include_bytes!("fixtures/unshield_public_inputs");
const OTAG_U: &[u8] = include_bytes!("fixtures/owner_tag_u");
// The payout address the unshield proof's `recipient` field commits to (a fixed test address).
const UNSHIELD_TO: &str = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const UNSHIELD_OP: u32 = 2;

// Order A/B and unshield note parameters (must match the fixtures' proofs).
const ASSET_1: u32 = 1;
const ASSET_2: u32 = 2;
const AMOUNT_A: i128 = 100; // order A offers 100 of asset 1
const AMOUNT_B: i128 = 2000; // order B offers 2000 of asset 2
const AMOUNT_U: i128 = 100; // unshield note: 100 of asset 1
const W_AMOUNT_IN: usize = 4;

fn test_env() -> Env {
    let env = Env::default();
    env.ledger().set_protocol_version(26);
    env.cost_estimate().budget().reset_unlimited();
    env.mock_all_auths();
    env
}

fn deploy(env: &Env) -> (Address, Address) {
    let admin = Address::generate(env);
    let vk = Bytes::from_slice(env, VK);
    let id = env.register(Settlement, (vk, admin.clone()));
    (id, admin)
}

fn bytes(env: &Env, b: &[u8]) -> Bytes {
    Bytes::from_slice(env, b)
}

fn tag(env: &Env, b: &[u8]) -> BytesN<32> {
    BytesN::from_array(env, &b.try_into().unwrap())
}

/// Register a Stellar Asset Contract for `asset_id`, mint `amount` to a fresh holder, and return it.
fn register_funded_asset(env: &Env, id: &Address, asset_id: u32, amount: i128) -> (Address, Address) {
    let token_admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token = sac.address();
    let holder = Address::generate(env);
    StellarAssetClient::new(env, &token).mint(&holder, &amount);
    SettlementClient::new(env, id).register_asset(&asset_id, &token);
    (token, holder)
}

// ===========================================================================
// Happy path: shield both notes into the on-chain tree, then settle atomically.
// ===========================================================================

#[test]
fn settle_two_crossing_orders() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);

    // Shield the two input notes -> the on-chain tree advances to root R2, which both order proofs
    // were made against. No admin push_root: the root is produced by the inserts themselves.
    let (_t1, h1) = register_funded_asset(&env, &id, ASSET_1, AMOUNT_A);
    let (_t2, h2) = register_funded_asset(&env, &id, ASSET_2, AMOUNT_B);
    client.shield(&h1, &ASSET_1, &AMOUNT_A, &tag(&env, OTAG_A));
    client.shield(&h2, &ASSET_2, &AMOUNT_B, &tag(&env, OTAG_B));

    client.settle(
        &bytes(&env, PROOF_A),
        &bytes(&env, PI_A),
        &bytes(&env, PROOF_B),
        &bytes(&env, PI_B),
    );

    // One settled event from this contract (the shields and token transfers emit their own).
    assert_eq!(env.events().all().filter_by_contract(&id).events().len(), 1);

    // Both nullifiers recorded: re-settling the same pair is rejected.
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
fn settle_rejects_unknown_root() {
    // Without shielding, the on-chain tree never produced R2, so the proofs' root is not accepted.
    let env = test_env();
    let (id, _admin) = deploy(&env);
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
        .expect_err("unknown root");
    assert_eq!(err as u32, Error::UnknownRoot as u32);
}

#[test]
fn settle_rejects_tampered_order_field() {
    // The proof binds every order field: a valid proof with a tampered amount_in fails to verify.
    let env = test_env();
    let (id, _admin) = deploy(&env);
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
    let short = &PI_A[..PI_A.len() - 32];
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
    // Order A against itself does not cross. Shield both notes so R2 is accepted and the crossing
    // check is what rejects (not the root check).
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    let (_t1, h1) = register_funded_asset(&env, &id, ASSET_1, AMOUNT_A);
    let (_t2, h2) = register_funded_asset(&env, &id, ASSET_2, AMOUNT_B);
    client.shield(&h1, &ASSET_1, &AMOUNT_A, &tag(&env, OTAG_A));
    client.shield(&h2, &ASSET_2, &AMOUNT_B, &tag(&env, OTAG_B));

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
// Pair registry + settle_exact (Phase 1).
// ===========================================================================

#[test]
fn register_pair_assigns_ids_and_rejects_noncanonical() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    register_funded_asset(&env, &id, ASSET_1, AMOUNT_A);
    register_funded_asset(&env, &id, ASSET_2, AMOUNT_B);

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
    let (id, _admin) = deploy(&env);
    register_funded_asset(&env, &id, ASSET_1, AMOUNT_A);

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
fn settle_exact_rejects_unregistered_pair() {
    // Existing crossing proofs, both notes shielded (root accepted), but no pair registered.
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    let (_t1, h1) = register_funded_asset(&env, &id, ASSET_1, AMOUNT_A);
    let (_t2, h2) = register_funded_asset(&env, &id, ASSET_2, AMOUNT_B);
    client.shield(&h1, &ASSET_1, &AMOUNT_A, &tag(&env, OTAG_A));
    client.shield(&h2, &ASSET_2, &AMOUNT_B, &tag(&env, OTAG_B));

    let err = env
        .as_contract(&id, || {
            Settlement::settle_exact(
                env.clone(),
                bytes(&env, PROOF_A),
                bytes(&env, PI_A),
                bytes(&env, PROOF_B),
                bytes(&env, PI_B),
            )
        })
        .expect_err("pair not registered");
    assert_eq!(err as u32, Error::PairNotRegistered as u32);
}

#[test]
fn settle_exact_accepts_exact_reverse() {
    // A and B are exact reverses: A gives 100 asset1 / wants 2000 asset2; B gives 2000 asset2 /
    // wants 100 asset1. Both proofs are made against the root produced by shielding the two notes.
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    let (_t1, h1) = register_funded_asset(&env, &id, ASSET_1, AMOUNT_A);
    let (_t2, h2) = register_funded_asset(&env, &id, ASSET_2, AMOUNT_B);
    client.shield(&h1, &ASSET_1, &AMOUNT_A, &tag(&env, OTAG_EXA));
    client.shield(&h2, &ASSET_2, &AMOUNT_B, &tag(&env, OTAG_EXB));
    client.register_pair(&ASSET_1, &ASSET_2);

    client.settle_exact(
        &bytes(&env, PROOF_EXA),
        &bytes(&env, PI_EXA),
        &bytes(&env, PROOF_EXB),
        &bytes(&env, PI_EXB),
    );

    // One settled event, and the pair is consumed: replaying is rejected (nullifiers recorded).
    assert_eq!(env.events().all().filter_by_contract(&id).events().len(), 1);
    let err = env
        .as_contract(&id, || {
            Settlement::settle_exact(
                env.clone(),
                bytes(&env, PROOF_EXA),
                bytes(&env, PI_EXA),
                bytes(&env, PROOF_EXB),
                bytes(&env, PI_EXB),
            )
        })
        .expect_err("replayed settle_exact");
    assert_eq!(err as u32, Error::NullifierUsed as u32);
}

#[test]
fn settle_exact_rejects_inexact_reverse() {
    // The committed fixtures cross (A wants >=1500 for 100; B wants >=50 for 2000) but are NOT exact
    // reverses, so settle_exact rejects them with NotCompatible even though both proofs verify.
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    let (_t1, h1) = register_funded_asset(&env, &id, ASSET_1, AMOUNT_A);
    let (_t2, h2) = register_funded_asset(&env, &id, ASSET_2, AMOUNT_B);
    client.shield(&h1, &ASSET_1, &AMOUNT_A, &tag(&env, OTAG_A));
    client.shield(&h2, &ASSET_2, &AMOUNT_B, &tag(&env, OTAG_B));
    client.register_pair(&ASSET_1, &ASSET_2);

    let err = env
        .as_contract(&id, || {
            Settlement::settle_exact(
                env.clone(),
                bytes(&env, PROOF_A),
                bytes(&env, PI_A),
                bytes(&env, PROOF_B),
                bytes(&env, PI_B),
            )
        })
        .expect_err("inexact reverse");
    assert_eq!(err as u32, Error::NotCompatible as u32);
}

// ===========================================================================
// Custody: shield moves a real token into the contract and inserts an AssetNote.
// ===========================================================================

#[test]
fn shield_moves_tokens_into_custody_and_advances_root() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    let (token, holder) = register_funded_asset(&env, &id, ASSET_1, AMOUNT_A);

    let root_before = client.root();
    client.shield(&holder, &ASSET_1, &AMOUNT_A, &tag(&env, OTAG_A));

    // The shielded event announced the note; check before the cross-contract balance reads.
    assert_eq!(env.events().all().filter_by_contract(&id).events().len(), 1);
    // The tree root advanced (a leaf was inserted).
    assert_ne!(client.root(), root_before);

    // Tokens left the holder and now sit in custody.
    let tc = TokenClient::new(&env, &token);
    assert_eq!(tc.balance(&holder), 0);
    assert_eq!(tc.balance(&id), AMOUNT_A);
}

#[test]
fn shield_rejects_unregistered_asset() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let user = Address::generate(&env);
    let err = env
        .as_contract(&id, || {
            Settlement::shield(env.clone(), user.clone(), 99, 100, tag(&env, OTAG_A))
        })
        .expect_err("unregistered asset");
    assert_eq!(err as u32, Error::AssetNotRegistered as u32);
}

#[test]
fn shield_rejects_nonpositive_amount() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let (_t, holder) = register_funded_asset(&env, &id, ASSET_1, AMOUNT_A);
    let err = env
        .as_contract(&id, || {
            Settlement::shield(env.clone(), holder.clone(), ASSET_1, 0, tag(&env, OTAG_A))
        })
        .expect_err("zero amount");
    assert_eq!(err as u32, Error::InvalidAmount as u32);
}

#[test]
fn register_asset_rejects_rebind() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let (_t, _h) = register_funded_asset(&env, &id, ASSET_1, AMOUNT_A);
    let other = Address::generate(&env);
    let err = env
        .as_contract(&id, || {
            Settlement::register_asset(env.clone(), ASSET_1, other.clone())
        })
        .expect_err("rebind");
    assert_eq!(err as u32, Error::AssetAlreadyRegistered as u32);
}

// ===========================================================================
// Unshield: shield a note (advancing the tree), then spend it to the bound recipient.
// ===========================================================================

/// Deploy, register the unshield VK, shield the unshield note (funds custody + advances the tree to
/// R_U, the root the proof was made against), and return (token, bound recipient).
fn setup_unshield(env: &Env, id: &Address) -> (Address, Address) {
    let (token, holder) = register_funded_asset(env, id, ASSET_1, AMOUNT_U);
    let client = SettlementClient::new(env, id);
    client.set_vk(&UNSHIELD_OP, &bytes(env, UNSHIELD_VK));
    client.shield(&holder, &ASSET_1, &AMOUNT_U, &tag(env, OTAG_U));
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

    let tc = TokenClient::new(&env, &token);
    assert_eq!(tc.balance(&to), AMOUNT_U);
    assert_eq!(tc.balance(&id), 0);

    // Replaying the same proof is rejected (nullifier recorded).
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
fn unshield_rejects_unknown_root() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    // Register the VK but do NOT shield, so R_U was never produced on-chain.
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
        .expect_err("unknown root");
    assert_eq!(err as u32, Error::UnknownRoot as u32);
}

#[test]
fn unshield_rejects_missing_vk() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
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
// Path server: the off-chain indexer reproduces the on-chain root and serves membership paths
// that satisfy the circuit, against the SAME root the committed order proofs were made for.
// ===========================================================================

/// Read the 32-byte big-endian word at field index `w` of a public-input blob.
fn pi_word(pi: &[u8], w: usize) -> [u8; 32] {
    pi[w * 32..w * 32 + 32].try_into().unwrap()
}

#[test]
fn indexer_reproduces_onchain_root_and_serves_valid_paths() {
    use mosaic_indexer::{u256_to_word, NoteTree};

    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);

    // Shield the two input notes on the REAL contract -> the on-chain tree advances to R2.
    let (_t1, h1) = register_funded_asset(&env, &id, ASSET_1, AMOUNT_A);
    let (_t2, h2) = register_funded_asset(&env, &id, ASSET_2, AMOUNT_B);
    client.shield(&h1, &ASSET_1, &AMOUNT_A, &tag(&env, OTAG_A));
    client.shield(&h2, &ASSET_2, &AMOUNT_B, &tag(&env, OTAG_B));
    let onchain_root = client.root().to_array();

    // Feed the SAME two shield events into the off-chain indexer (sharing the test's Env as the
    // hash engine, so the U256s are comparable and the host hash is identical).
    let mut tree = NoteTree::new(&env);
    let ia = tree.ingest_shielded(ASSET_1, AMOUNT_A, OTAG_A.try_into().unwrap());
    let ib = tree.ingest_shielded(ASSET_2, AMOUNT_B, OTAG_B.try_into().unwrap());
    assert_eq!((ia, ib), (0, 1), "shields land at leaf indices 0 and 1");
    let indexer_root = u256_to_word(&tree.root());

    // (1) The indexer's root equals the on-chain root...
    assert_eq!(
        indexer_root, onchain_root,
        "indexer root must equal the on-chain tree root"
    );
    // (2) ...and equals the membership root BOTH committed order proofs were generated against
    //     (public input field [1] = root). This is the whole point: a wallet using the indexer's
    //     view proves against exactly the root the contract will accept.
    assert_eq!(pi_word(PI_A, 1), onchain_root, "order A proof root == on-chain root");
    assert_eq!(pi_word(PI_B, 1), onchain_root, "order B proof root == on-chain root");

    // (3) Every leaf's indexer-derived path folds (with the circuit's membership algorithm) back to
    //     the root, so a proof built from that witness satisfies the lift circuit's membership
    //     constraint without having to run bb here.
    for i in 0..tree.len() {
        let leaf = tree.leaf(i).unwrap();
        let p = tree.path(i);
        assert_eq!(
            u256_to_word(&tree.circuit_fold(&leaf, &p)),
            onchain_root,
            "indexer path for leaf {i} must fold to the on-chain root"
        );
    }
}

#[test]
fn indexer_reproduces_unshield_root() {
    use mosaic_indexer::{u256_to_word, NoteTree};

    let env = test_env();
    let (id, _admin) = deploy(&env);
    let (_token, _to) = setup_unshield(&env, &id);
    let onchain_root = SettlementClient::new(&env, &id).root().to_array();

    // The unshield note is a single shield of asset 1 / amount 100 / owner_tag_u at index 0.
    let mut tree = NoteTree::new(&env);
    tree.ingest_shielded(ASSET_1, AMOUNT_U, OTAG_U.try_into().unwrap());

    assert_eq!(u256_to_word(&tree.root()), onchain_root, "indexer root == on-chain root");
    assert_eq!(pi_word(UNSHIELD_PI, 1), onchain_root, "unshield proof root == on-chain root");

    let leaf = tree.leaf(0).unwrap();
    let p = tree.path(0);
    assert_eq!(
        u256_to_word(&tree.circuit_fold(&leaf, &p)),
        onchain_root,
        "indexer path for the unshield note must fold to the on-chain root"
    );
}

// ===========================================================================
// Budget sanity (local host metering under-counts vs on-chain; regression guard only).
// ===========================================================================

#[test]
fn settle_fits_cpu_budget() {
    let env = test_env();
    let (id, _admin) = deploy(&env);
    let client = SettlementClient::new(&env, &id);
    let (_t1, h1) = register_funded_asset(&env, &id, ASSET_1, AMOUNT_A);
    let (_t2, h2) = register_funded_asset(&env, &id, ASSET_2, AMOUNT_B);
    client.shield(&h1, &ASSET_1, &AMOUNT_A, &tag(&env, OTAG_A));
    client.shield(&h2, &ASSET_2, &AMOUNT_B, &tag(&env, OTAG_B));

    env.cost_estimate().budget().reset_unlimited();
    client.settle(
        &bytes(&env, PROOF_A),
        &bytes(&env, PI_A),
        &bytes(&env, PROOF_B),
        &bytes(&env, PI_B),
    );
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();
    std::println!("atomic settle + 2 tree inserts CPU (local host): {cpu}");
    assert!(cpu < 400_000_000, "settle CPU {cpu} exceeds the 400M budget");
}
