//! End-to-end demo: the FULL private-DEX lifecycle — shield -> order -> settle -> unshield — run
//! against the real contract on the local Soroban host, with REAL UltraHonk proofs whose membership
//! witnesses were reconstructed by the off-chain path server (tools/indexer).
//!
//! The headline: A shields asset 1, trades into asset 2 via an atomic settle, and then UNSHIELDS the
//! proceeds note that `settle` created — a note that exists only as a tree leaf, whose Merkle path
//! the path server rebuilt from the shield+settle event history. Without the path server this last
//! step is impossible.
//!
//! Fixtures (tests/fixtures/demo/) are real bb artifacts committed so this runs under a plain
//! `cargo test` with no Noir/bb toolchain. Regenerate them with `scripts/03_demo_e2e.sh` if the
//! circuits or scenario change. To watch the narration: `cargo test --test e2e_demo -- --nocapture`.

use mosaic_indexer::{u256_to_word, NoteTree};
use settlement::{Settlement, SettlementClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env, String,
};

// Demo fixtures (see scripts/03_demo_e2e.sh for the scenario + secrets).
const LIFT_VK: &[u8] = include_bytes!("fixtures/demo/vk");
const PROOF_A: &[u8] = include_bytes!("fixtures/demo/proof_a");
const PI_A: &[u8] = include_bytes!("fixtures/demo/public_inputs_a");
const PROOF_B: &[u8] = include_bytes!("fixtures/demo/proof_b");
const PI_B: &[u8] = include_bytes!("fixtures/demo/public_inputs_b");
const OTAG_A: &[u8] = include_bytes!("fixtures/demo/owner_tag_a");
const OTAG_B: &[u8] = include_bytes!("fixtures/demo/owner_tag_b");
const UNSHIELD_VK: &[u8] = include_bytes!("fixtures/demo/unshield_vk");
const UNSHIELD_PROOF: &[u8] = include_bytes!("fixtures/demo/unshield_proof");
const UNSHIELD_PI: &[u8] = include_bytes!("fixtures/demo/unshield_public_inputs");

// Must match scripts/03_demo_e2e.sh.
const ASSET_1: u32 = 1;
const ASSET_2: u32 = 2;
const AMT_A: i128 = 100; // A shields 100 of asset 1
const AMT_B: i128 = 2000; // B shields 2000 of asset 2
const DEMO_TO: &str = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

fn bytes(env: &Env, b: &[u8]) -> Bytes {
    Bytes::from_slice(env, b)
}
fn tag(env: &Env, b: &[u8]) -> BytesN<32> {
    BytesN::from_array(env, &b.try_into().unwrap())
}

/// Register a Stellar Asset Contract for `asset_id`, mint `amount` to a fresh holder, return both.
fn register_funded_asset(env: &Env, id: &Address, asset_id: u32, amount: i128) -> (Address, Address) {
    let token_admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token = sac.address();
    let holder = Address::generate(env);
    StellarAssetClient::new(env, &token).mint(&holder, &amount);
    SettlementClient::new(env, id).register_asset(&asset_id, &token);
    (token, holder)
}

#[test]
fn full_lifecycle_shield_order_settle_unshield() {
    let env = Env::default();
    env.ledger().set_protocol_version(26);
    env.cost_estimate().budget().reset_unlimited();
    env.mock_all_auths();

    // Deploy the merged contract with the order/lift VK; register the unshield VK.
    let admin = Address::generate(&env);
    let id = env.register(
        Settlement,
        (
            bytes(&env, LIFT_VK),
            bytes(&env, UNSHIELD_VK),
            bytes(&env, LIFT_VK),
            bytes(&env, LIFT_VK),
            admin.clone(),
        ),
    );
    let client = SettlementClient::new(&env, &id);

    // Custody-backing tokens: A is funded 100 of asset 1, B is funded 2000 of asset 2.
    let (token1, holder_a) = register_funded_asset(&env, &id, ASSET_1, AMT_A);
    let (token2, holder_b) = register_funded_asset(&env, &id, ASSET_2, AMT_B);
    let tc1 = TokenClient::new(&env, &token1);
    let tc2 = TokenClient::new(&env, &token2);

    // An off-chain path server mirroring the same event history (proves the witnesses came from it).
    let mut tree = NoteTree::new(&env);

    // --- 1. SHIELD --------------------------------------------------------------------------------
    client.shield(&holder_a, &ASSET_1, &AMT_A, &tag(&env, OTAG_A));
    tree.ingest_shielded(ASSET_1, AMT_A, OTAG_A.try_into().unwrap());
    client.shield(&holder_b, &ASSET_2, &AMT_B, &tag(&env, OTAG_B));
    tree.ingest_shielded(ASSET_2, AMT_B, OTAG_B.try_into().unwrap());
    assert_eq!(tc1.balance(&id), AMT_A, "custody holds A's 100 asset1");
    assert_eq!(tc2.balance(&id), AMT_B, "custody holds B's 2000 asset2");
    assert_eq!(
        u256_to_word(&tree.root()),
        client.root().to_array(),
        "path-server root == on-chain root R2 (the root both order proofs were made against)"
    );
    std::println!("[1] shield: custody = 100 asset1 + 2000 asset2; tree root R2 reproduced off-chain");

    // --- 2. ORDER (off-chain) + 3. SETTLE (atomic, two verifies) ----------------------------------
    // A: give 100 asset1, want >=1500 asset2.  B: give 2000 asset2, want >=50 asset1. They cross.
    client.settle(
        &bytes(&env, PROOF_A),
        &bytes(&env, PI_A),
        &bytes(&env, PROOF_B),
        &bytes(&env, PI_B),
    );
    // Settle moved no real tokens (it shuffles NOTE ownership); custody is unchanged. It minted two
    // proceeds notes into the tree: leaf 2 = A's 2000 asset2, leaf 3 = B's 100 asset1.
    let otag_a_out = OTAG_A_OUT(&env);
    let otag_b_out = OTAG_B_OUT(&env);
    tree.ingest_settled(ASSET_2, AMT_B, &otag_a_out, ASSET_1, AMT_A, &otag_b_out);
    assert_eq!(tc1.balance(&id), AMT_A);
    assert_eq!(tc2.balance(&id), AMT_B);
    assert_eq!(
        u256_to_word(&tree.root()),
        client.root().to_array(),
        "path-server root == on-chain root R4 after settle inserted the proceeds notes"
    );
    std::println!("[2/3] settle: atomic two-proof trade; proceeds notes minted; tree root R4 reproduced");

    // --- 4. UNSHIELD A's proceeds note (the SETTLE-created leaf 2) ---------------------------------
    // The membership path for leaf 2 was reconstructed by the path server from the event history;
    // the proof binds the recipient so the (mock) relayer submitting it cannot redirect the funds.
    let to = Address::from_string(&String::from_str(&env, DEMO_TO));
    assert_eq!(tc2.balance(&to), 0, "recipient starts with no asset2");
    client.unshield(&to, &bytes(&env, UNSHIELD_PROOF), &bytes(&env, UNSHIELD_PI));

    assert_eq!(tc2.balance(&to), AMT_B, "recipient received A's 2000 asset2 proceeds");
    assert_eq!(tc2.balance(&id), 0, "custody asset2 fully withdrawn");
    assert_eq!(tc1.balance(&id), AMT_A, "B's 100 asset1 proceeds still in custody as a note");
    std::println!("[4] unshield: A withdrew its settle-created 2000 asset2 note to a real address");
    std::println!("    Full shield -> order -> settle -> unshield lifecycle complete.");
}

// A's / B's proceeds stealth tags = notetag(skX2, rhoX2) from the demo script
// (skA2=5555/rhoA2=6666, skB2=7777/rhoB2=8888). Recomputed here so the off-chain tree builds the
// same proceeds leaves the contract did, matching root R4.
#[allow(non_snake_case)]
fn OTAG_A_OUT(env: &Env) -> [u8; 32] {
    notetag(env, 5555, 6666)
}
#[allow(non_snake_case)]
fn OTAG_B_OUT(env: &Env) -> [u8; 32] {
    notetag(env, 7777, 8888)
}

/// owner_tag = compress(compress(sk,0), rho), matching the witness tool's `notetag`.
fn notetag(env: &Env, sk: u128, rho: u128) -> [u8; 32] {
    use mosaic_indexer::{u256_to_word, Hasher};
    use soroban_sdk::U256;
    let h = Hasher::new(env);
    let sk = U256::from_u128(env, sk);
    let rho = U256::from_u128(env, rho);
    let zero = U256::from_u32(env, 0);
    let pk = h.compress(env, &sk, &zero);
    u256_to_word(&h.compress(env, &pk, &rho))
}
