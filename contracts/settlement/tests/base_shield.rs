//! WS4 — `shield_from_base`: mint an AssetNote on Stellar from a proven Base deposit.
//!
//! The real RISC Zero verifier router pins soroban-sdk 25.1.0, so we cannot link its crate into this
//! 26.0.1 contract. Instead the contract cross-calls the router by address via `env.invoke_contract`
//! (SDK-version agnostic), and these tests register a MOCK router (compiled here) that accepts iff
//! the seal starts with 0x01 — exercising the full parse / config / registry / replay logic
//! independently of a live verifier. The journal layout is built word-by-word and cross-checked
//! against the exact bytes alloy's `abi_encode` produced (see bridge-prover fixture printer).

use settlement::{Error, Settlement, SettlementClient};
use soroban_sdk::{
    contract, contracterror, contractimpl,
    testutils::{Address as _, Events, Ledger},
    Address, Bytes, BytesN, Env,
};

// ---- mock RISC Zero verifier router ----

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MockErr {
    Rejected = 1,
}

#[contract]
pub struct MockRouter;

#[contractimpl]
impl MockRouter {
    /// Matches the router's `verify(seal, image_id, journal_digest)`. Accepts iff `seal[0] == 1`, so
    /// tests drive accept/reject by the seal byte without a real proof.
    pub fn verify(
        _env: Env,
        seal: Bytes,
        _image_id: BytesN<32>,
        _journal: BytesN<32>,
    ) -> Result<(), MockErr> {
        if seal.get(0) == Some(1) {
            Ok(())
        } else {
            Err(MockErr::Rejected)
        }
    }
}

// The journal byte layout below was cross-checked against alloy's `Journal::abi_encode()` output
// (the bridge-prover `print_journal_fixture` test). The per-field negative tests further confirm
// each offset maps to the field this contract reads.

// ---- fixture values (must match the bridge-prover fixture printer) ----

const VK: &[u8] = include_bytes!("fixtures/vk");
const BLOCK_NUMBER: u64 = 0x1234;
const BLOCK_HASH: [u8; 32] = [0x11; 32];
const CONFIG_ID: [u8; 32] = [0x22; 32];
const BRIDGE20: [u8; 20] = [0xAB; 20];
const DEPOSIT_ID: u64 = 7;
const ASSET_ID: u32 = 1;
const AMOUNT: i128 = 100_000_000;
const OWNER_TAG: [u8; 32] = [0x33; 32];
// Real bridge-prover guest image id (bridge_methods::BRIDGE_GUEST_ID); the mock ignores it.
const IMAGE_ID: [u8; 32] = [
    0x70, 0x3c, 0x61, 0x8f, 0xf0, 0x49, 0x97, 0xc2, 0x93, 0x75, 0x52, 0xd4, 0x01, 0x03, 0x47, 0x20,
    0x81, 0xaa, 0x87, 0xc1, 0x6c, 0x71, 0x1d, 0xe5, 0xc6, 0xec, 0xe5, 0x60, 0x7f, 0x0e, 0xe2, 0x81,
];

// ---- helpers ----

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

/// Build the 8-word (256-byte) ABI journal exactly as the guest commits it.
#[allow(clippy::too_many_arguments)]
fn build_journal(
    block_number: u64,
    block_hash: &[u8; 32],
    config_id: &[u8; 32],
    bridge20: &[u8; 20],
    deposit_id: u64,
    asset_id: u32,
    amount: i128,
    owner_tag: &[u8; 32],
) -> [u8; 256] {
    let mut b = [0u8; 256];
    b[24..32].copy_from_slice(&block_number.to_be_bytes()); // w0: id (version 0 | block number)
    b[32..64].copy_from_slice(block_hash); // w1
    b[64..96].copy_from_slice(config_id); // w2
    b[96 + 12..128].copy_from_slice(bridge20); // w3: 12 zero bytes then 20 addr bytes
    b[128 + 24..160].copy_from_slice(&deposit_id.to_be_bytes()); // w4
    b[160 + 28..192].copy_from_slice(&asset_id.to_be_bytes()); // w5
    b[192 + 16..224].copy_from_slice(&amount.to_be_bytes()); // w6 (i128 in low 16 bytes)
    b[224..256].copy_from_slice(owner_tag); // w7
    b
}

fn fixture_journal() -> [u8; 256] {
    build_journal(
        BLOCK_NUMBER, &BLOCK_HASH, &CONFIG_ID, &BRIDGE20, DEPOSIT_ID, ASSET_ID, AMOUNT, &OWNER_TAG,
    )
}

fn register_asset(env: &Env, id: &Address, asset_id: u32) {
    let sac = env.register_stellar_asset_contract_v2(Address::generate(env));
    SettlementClient::new(env, id).register_asset(&asset_id, &sac.address());
}

/// Deploy settlement + mock router, configure the bridge, attest the fixture block, register asset.
fn setup(env: &Env) -> (Address, Address) {
    let (id, _admin) = deploy(env);
    let router = env.register(MockRouter, ());
    let client = SettlementClient::new(env, &id);
    client.configure_base_bridge(
        &router,
        &BytesN::from_array(env, &IMAGE_ID),
        &BytesN::from_array(env, &CONFIG_ID),
        &BytesN::from_array(env, &BRIDGE20),
    );
    client.attest_base_block(&BLOCK_NUMBER, &BytesN::from_array(env, &BLOCK_HASH));
    register_asset(env, &id, ASSET_ID);
    (id, router)
}

fn good_seal(env: &Env) -> Bytes {
    Bytes::from_array(env, &[1u8])
}

fn journal_bytes(env: &Env, j: &[u8; 256]) -> Bytes {
    Bytes::from_array(env, j)
}

/// Direct (non-panicking) invocation, for typed-error assertions.
fn call(env: &Env, id: &Address, seal: Bytes, journal: Bytes) -> Result<(), Error> {
    env.as_contract(id, || Settlement::shield_from_base(env.clone(), seal, journal))
}

// ===========================================================================

#[test]
fn shield_from_base_mints_note_and_advances_root() {
    let env = test_env();
    let (id, _router) = setup(&env);
    let client = SettlementClient::new(&env, &id);

    let root_before = client.root();
    client.shield_from_base(&good_seal(&env), &journal_bytes(&env, &fixture_journal()));

    // Exactly one event from settlement: the `shielded` event the indexer replays. Asserted before
    // any further invocation, since the test env's event buffer reflects the latest call.
    assert_eq!(env.events().all().filter_by_contract(&id).events().len(), 1);
    assert_ne!(client.root(), root_before, "tree root must advance on mint");
}

#[test]
fn shield_from_base_rejects_replayed_deposit() {
    let env = test_env();
    let (id, _router) = setup(&env);
    let client = SettlementClient::new(&env, &id);
    let j = journal_bytes(&env, &fixture_journal());

    client.shield_from_base(&good_seal(&env), &j);
    let err = call(&env, &id, good_seal(&env), j).expect_err("replayed deposit");
    assert_eq!(err as u32, Error::DepositAlreadyProcessed as u32);
}

#[test]
fn shield_from_base_rejects_invalid_proof() {
    let env = test_env();
    let (id, _router) = setup(&env);
    let client = SettlementClient::new(&env, &id);
    // Bad seal -> mock router returns Err -> the cross-call traps -> the whole call fails.
    let bad = Bytes::from_array(&env, &[0u8]);
    let res = client.try_shield_from_base(&bad, &journal_bytes(&env, &fixture_journal()));
    assert!(res.is_err(), "an invalid proof must make shield_from_base fail");
}

#[test]
fn shield_from_base_requires_configuration() {
    let env = test_env();
    let (id, _admin) = deploy(&env); // not configured
    let err = call(&env, &id, good_seal(&env), journal_bytes(&env, &fixture_journal()))
        .expect_err("unconfigured");
    assert_eq!(err as u32, Error::BaseBridgeNotConfigured as u32);
}

#[test]
fn shield_from_base_rejects_wrong_journal_length() {
    let env = test_env();
    let (id, _router) = setup(&env);
    let short = Bytes::from_array(&env, &[0u8; 100]);
    let err = call(&env, &id, good_seal(&env), short).expect_err("bad length");
    assert_eq!(err as u32, Error::BadJournal as u32);
}

#[test]
fn shield_from_base_rejects_wrong_config_id() {
    let env = test_env();
    let (id, _router) = setup(&env);
    let mut j = fixture_journal();
    j[64] ^= 0xff; // corrupt configID
    let err = call(&env, &id, good_seal(&env), journal_bytes(&env, &j)).expect_err("config");
    assert_eq!(err as u32, Error::ConfigMismatch as u32);
}

#[test]
fn shield_from_base_rejects_wrong_bridge() {
    let env = test_env();
    let (id, _router) = setup(&env);
    let mut j = fixture_journal();
    j[96 + 12] ^= 0xff; // corrupt bridge address
    let err = call(&env, &id, good_seal(&env), journal_bytes(&env, &j)).expect_err("bridge");
    assert_eq!(err as u32, Error::BridgeMismatch as u32);
}

#[test]
fn shield_from_base_rejects_unattested_block() {
    let env = test_env();
    let (id, _router) = setup(&env);
    let mut j = fixture_journal();
    // A different block number that was never attested.
    j[24..32].copy_from_slice(&0x9999u64.to_be_bytes());
    let err = call(&env, &id, good_seal(&env), journal_bytes(&env, &j)).expect_err("block");
    assert_eq!(err as u32, Error::BaseBlockNotAttested as u32);
}

#[test]
fn shield_from_base_rejects_tampered_block_hash() {
    let env = test_env();
    let (id, _router) = setup(&env);
    let mut j = fixture_journal();
    j[32] ^= 0xff; // block hash differs from the attested one for this block number
    let err = call(&env, &id, good_seal(&env), journal_bytes(&env, &j)).expect_err("hash");
    assert_eq!(err as u32, Error::BaseBlockNotAttested as u32);
}

#[test]
fn shield_from_base_rejects_unregistered_asset() {
    let env = test_env();
    let (id, _router) = setup(&env);
    let mut j = fixture_journal();
    j[160 + 28..192].copy_from_slice(&99u32.to_be_bytes()); // asset 99 not registered
    let err = call(&env, &id, good_seal(&env), journal_bytes(&env, &j)).expect_err("asset");
    assert_eq!(err as u32, Error::AssetNotRegistered as u32);
}

// ---- WS5: a bridged note is discoverable + spendable via the off-chain indexer ----
// `shield_from_base` emits the same `shielded(asset_id, amount, owner_tag)` event and inserts the
// same `Poseidon(asset_id, amount, owner_tag)` leaf as a native shield, so the existing indexer
// (tools/indexer) and backend event scanner reconstruct it with no changes. These tests prove the
// minted note's membership path folds to the on-chain root — i.e. a wallet can prove membership and
// thus trade/unshield it like any native note.

#[test]
fn base_minted_note_reconstructs_and_membership_path_folds() {
    use mosaic_indexer::{u256_to_word, NoteTree};

    let env = test_env();
    let (id, _router) = setup(&env);
    let client = SettlementClient::new(&env, &id);

    client.shield_from_base(&good_seal(&env), &journal_bytes(&env, &fixture_journal()));
    let onchain_root = client.root().to_array();

    // Replay the `shielded` event (what the backend scanner does from chain) into the indexer.
    let mut tree = NoteTree::new(&env);
    let idx = tree.ingest_shielded(ASSET_ID, AMOUNT, &OWNER_TAG);
    assert_eq!(idx, 0, "the base mint is the first leaf");

    // (1) off-chain reconstruction reproduces the on-chain root exactly.
    assert_eq!(u256_to_word(&tree.root()), onchain_root, "indexer root == on-chain root");
    // (2) the reconstructed membership path folds (via the circuit's algorithm) to that root, so a
    //     lift/unshield proof built from this witness will satisfy the membership constraint.
    let leaf = tree.leaf(0).unwrap();
    let path = tree.path(0);
    assert_eq!(
        u256_to_word(&tree.circuit_fold(&leaf, &path)),
        onchain_root,
        "base-minted note's membership path must fold to the on-chain root",
    );
}

#[test]
fn base_and_native_notes_coexist_in_one_tree() {
    use mosaic_indexer::{u256_to_word, NoteTree};
    use soroban_sdk::token::StellarAssetClient;

    let env = test_env();
    let (id, _admin) = deploy(&env);
    let router = env.register(MockRouter, ());
    let client = SettlementClient::new(&env, &id);
    client.configure_base_bridge(
        &router,
        &BytesN::from_array(&env, &IMAGE_ID),
        &BytesN::from_array(&env, &CONFIG_ID),
        &BytesN::from_array(&env, &BRIDGE20),
    );
    client.attest_base_block(&BLOCK_NUMBER, &BytesN::from_array(&env, &BLOCK_HASH));

    // Register asset 1 to a real SAC and fund a holder so we can do a NATIVE shield too.
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    client.register_asset(&ASSET_ID, &sac.address());
    let holder = Address::generate(&env);
    let native_amount: i128 = 50;
    let native_tag = [0x22u8; 32]; // a valid (< r) field element
    StellarAssetClient::new(&env, &sac.address()).mint(&holder, &native_amount);

    // leaf 0 = native shield; leaf 1 = bridged mint.
    client.shield(&holder, &ASSET_ID, &native_amount, &BytesN::from_array(&env, &native_tag));
    client.shield_from_base(&good_seal(&env), &journal_bytes(&env, &fixture_journal()));
    let onchain_root = client.root().to_array();

    // The indexer replays both `shielded` events in insertion order — native and bridged are
    // indistinguishable to it (same event, same leaf function).
    let mut tree = NoteTree::new(&env);
    tree.ingest_shielded(ASSET_ID, native_amount, &native_tag);
    tree.ingest_shielded(ASSET_ID, AMOUNT, &OWNER_TAG);

    assert_eq!(u256_to_word(&tree.root()), onchain_root, "mixed tree root == on-chain root");
    for i in 0..tree.len() {
        let leaf = tree.leaf(i).unwrap();
        let path = tree.path(i);
        assert_eq!(
            u256_to_word(&tree.circuit_fold(&leaf, &path)),
            onchain_root,
            "leaf {i} path must fold to the on-chain root",
        );
    }
}
