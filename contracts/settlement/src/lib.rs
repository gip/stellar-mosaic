#![no_std]
//! Merged Desk + custody contract (the registry-ownership decision: one contract owns the single
//! note/nullifier registry, so lift never pays a cross-contract call on top of its ~81% verify).
//! See docs/architecture.md, docs/lift-circuit-spec.md.
//!
//! `shield`= move a real Soroban token into custody and mint an AssetNote. Proof-free: amounts are
//!           public and the token transfer enforces the amount, so value conservation needs no ZK.
//!           Emits the note fields; the off-chain tree builder ingests them and publishes the root.
//! `lift`  = VERIFY the lift proof (UltraHonk, native BN254 host fns), then derive EVERY order
//!           field from the proof's public inputs and store a validated order entry. Nothing the
//!           caller passes is trusted: asset/amount/price/output_owner_tag/cancel_owner_tag all
//!           come from the verified public-input vector, so settlement can trust them. The consumed
//!           asset note's nullifier is recorded at lift (nullify-at-lift => firm offers).
//! `settle`= consume TWO pre-verified order entries with NO proof verification: compatibility +
//!           price check in plaintext, then construct proceeds by stamping each order's bound
//!           `output_owner_tag` onto the matched fill amount. Atomic. No caller-supplied outputs.
//! `unshield` (TODO, next): spend an asset note with a proof and transfer the real token out, with
//!           the recipient bound into the proof so a relayer cannot redirect it.
//!
//! Public-input vector (10 x 32-byte big-endian field elements, see docs/lift-circuit-spec.md):
//!   [0] domain  [1] root  [2] nullifier_in  [3] asset_in  [4] amount_in  [5] asset_out
//!   [6] min_out [7] output_owner_tag  [8] cancel_owner_tag  [9] order_leaf

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token::TokenClient, Address,
    Bytes, BytesN, Env,
};
use ultrahonk_soroban_verifier::{UltraHonkVerifier, PROOF_BYTES};

/// Number of 32-byte public inputs the lift circuit exposes.
const NUM_PUBLIC_INPUTS: u32 = 10;
const PUBLIC_INPUTS_BYTES: u32 = NUM_PUBLIC_INPUTS * 32;
/// LIFT_DOMAIN constant from the circuit (Field value 1), as a 32-byte big-endian word.
const LIFT_DOMAIN: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
];

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    EntryNotFound = 1,
    AlreadyConsumed = 2,
    NullifierUsed = 3,
    NotCompatible = 4,
    VkNotSet = 5,
    VkInvalid = 6,
    ProofParseError = 7,
    VerificationFailed = 8,
    // Production lift binding (appended; existing codes above stay stable).
    BadPublicInputs = 9, // wrong public-input length or wrong domain separator
    UnknownRoot = 10,    // root not in the published root history
    FieldOverflow = 11,  // a field element did not fit the expected u32/i128 range
    // Custody layer (appended).
    AssetNotRegistered = 12, // no token contract mapped to this asset id
    InvalidAmount = 13,      // shield/unshield amount must be positive
    AssetAlreadyRegistered = 14, // asset id already mapped (admin must not silently rebind)
}

/// A validated resting order. Every field here is bound by the lift proof.
#[contracttype]
#[derive(Clone)]
pub struct PoolEntry {
    pub nullifier_in: BytesN<32>,     // consumed asset note's nullifier (recorded at lift)
    pub asset_in: u32,                // offered asset
    pub amount_in: i128,              // offered amount (full consumption)
    pub asset_out: u32,               // wanted asset
    pub min_out: i128,                // limit terms
    pub output_owner_tag: BytesN<32>, // proceeds destination (settle stamps this)
    pub cancel_owner_tag: BytesN<32>, // cancel authority
    pub order_leaf: BytesN<32>,       // order note leaf (for the off-chain tree)
    pub consumed: bool,
}

#[contracttype]
pub enum DataKey {
    Vk,
    Admin,
    Root(BytesN<32>),
    Entry(u32),
    Nullifier(BytesN<32>),
    Asset(u32), // asset id -> token contract Address
}

#[contract]
pub struct Settlement;

#[contractimpl]
impl Settlement {
    /// Store the UltraHonk verification key (validated by parsing) and the root publisher admin.
    pub fn __constructor(env: Env, vk_bytes: Bytes, admin: Address) -> Result<(), Error> {
        let _ = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|_| Error::VkInvalid)?;
        env.storage().instance().set(&DataKey::Vk, &vk_bytes);
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    /// Publish a Merkle root produced by the off-chain tree rebuild. Lift proofs may be made against
    /// any published root. Admin-gated (the off-chain tree publisher). Staleness/bounded-ring
    /// eviction is a later refinement; double-spend safety comes from nullifiers, not root recency.
    pub fn push_root(env: Env, root: BytesN<32>) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().persistent().set(&DataKey::Root(root), &true);
        Ok(())
    }

    /// Map a supported asset id to its real Soroban token contract. Admin-gated; assets are not
    /// silently rebindable (rebinding a live asset id would orphan custodied balances).
    pub fn register_asset(env: Env, asset_id: u32, token: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if env.storage().instance().has(&DataKey::Asset(asset_id)) {
            return Err(Error::AssetAlreadyRegistered);
        }
        env.storage().instance().set(&DataKey::Asset(asset_id), &token);
        Ok(())
    }

    /// Shield: move `amount` of a registered asset into custody and mint an AssetNote
    /// `{ asset_id, amount, owner_tag }`. Proof-free: the token transfer enforces the amount and
    /// amounts are public, so value conservation needs no ZK. The minted note's leaf
    /// `Poseidon(asset_id, amount, owner_tag)` is rebuilt off-chain from the emitted event; the
    /// contract does not pay on-chain Poseidon. `owner_tag` is the caller's opaque one-time address;
    /// choosing it wrongly only forfeits the caller's own ability to spend the note later.
    pub fn shield(
        env: Env,
        from: Address,
        asset_id: u32,
        amount: i128,
        owner_tag: BytesN<32>,
    ) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Asset(asset_id))
            .ok_or(Error::AssetNotRegistered)?;

        // Pull the real tokens into custody. `from` authorized above; the token contract enforces
        // the balance, so custody can never exceed what was actually shielded.
        TokenClient::new(&env, &token).transfer(&from, &env.current_contract_address(), &amount);

        // Announce the new AssetNote for the off-chain tree builder.
        env.events()
            .publish((symbol_short!("shielded"),), (asset_id, amount, owner_tag));
        Ok(())
    }

    /// Lift: verify the lift proof, derive the order from its public inputs, nullify the consumed
    /// asset note, and store a validated order entry. The caller supplies only the storage `id` and
    /// the proof artifacts; every order field is taken from the verified public inputs.
    pub fn lift(env: Env, id: u32, proof_bytes: Bytes, public_inputs: Bytes) -> Result<(), Error> {
        // --- verification (the expensive part, ~80% of budget) ---
        if proof_bytes.len() as usize != PROOF_BYTES {
            return Err(Error::ProofParseError);
        }
        if public_inputs.len() != PUBLIC_INPUTS_BYTES {
            return Err(Error::BadPublicInputs);
        }
        let vk_bytes: Bytes = env
            .storage()
            .instance()
            .get(&DataKey::Vk)
            .ok_or(Error::VkNotSet)?;
        let verifier = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|_| Error::VkInvalid)?;
        verifier
            .verify(&env, &proof_bytes, &public_inputs)
            .map_err(|_| Error::VerificationFailed)?;

        // --- bindings: everything below is now attested by the verified proof ---
        // [0] domain separator must be the lift constant.
        if read_word(&public_inputs, 0) != LIFT_DOMAIN {
            return Err(Error::BadPublicInputs);
        }
        // [1] root must be a published root.
        let root = BytesN::from_array(&env, &read_word(&public_inputs, 32));
        if !env.storage().persistent().has(&DataKey::Root(root)) {
            return Err(Error::UnknownRoot);
        }
        // [2] nullifier of the consumed asset note: must be unused, then record (nullify-at-lift).
        let nullifier_in = BytesN::from_array(&env, &read_word(&public_inputs, 64));
        let nf_key = DataKey::Nullifier(nullifier_in.clone());
        if env.storage().persistent().has(&nf_key) {
            return Err(Error::NullifierUsed);
        }
        // [3..7] order terms.
        let asset_in = word_to_u32(&read_word(&public_inputs, 96))?;
        let amount_in = word_to_i128(&read_word(&public_inputs, 128))?;
        let asset_out = word_to_u32(&read_word(&public_inputs, 160))?;
        let min_out = word_to_i128(&read_word(&public_inputs, 192))?;
        // [7..10] output/cancel tags and the order leaf.
        let output_owner_tag = BytesN::from_array(&env, &read_word(&public_inputs, 224));
        let cancel_owner_tag = BytesN::from_array(&env, &read_word(&public_inputs, 256));
        let order_leaf = BytesN::from_array(&env, &read_word(&public_inputs, 288));

        // --- commit: nullify the asset note, then store the validated order ---
        env.storage().persistent().set(&nf_key, &true);
        let entry = PoolEntry {
            nullifier_in,
            asset_in,
            amount_in,
            asset_out,
            min_out,
            output_owner_tag,
            cancel_owner_tag,
            order_leaf,
            consumed: false,
        };
        env.storage().persistent().set(&DataKey::Entry(id), &entry);
        Ok(())
    }

    /// Settle: consume two pre-verified order entries. NO proof verification. Proceeds are
    /// constructed from each order's bound `output_owner_tag` and the matched fill amount; the
    /// contract never accepts caller-supplied output commitments.
    pub fn settle(env: Env, id_a: u32, id_b: u32) -> Result<(), Error> {
        let mut a: PoolEntry = env
            .storage()
            .persistent()
            .get(&DataKey::Entry(id_a))
            .ok_or(Error::EntryNotFound)?;
        let mut b: PoolEntry = env
            .storage()
            .persistent()
            .get(&DataKey::Entry(id_b))
            .ok_or(Error::EntryNotFound)?;

        if a.consumed || b.consumed {
            return Err(Error::AlreadyConsumed);
        }
        // Assets must cross: A offers what B wants and vice versa.
        if a.asset_in != b.asset_out || a.asset_out != b.asset_in {
            return Err(Error::NotCompatible);
        }
        // Full-fill v1: each side receives the other's offered amount; both limits must be met.
        // A receives b.amount_in of a.asset_out; B receives a.amount_in of b.asset_out.
        if a.amount_in < b.min_out || b.amount_in < a.min_out {
            return Err(Error::NotCompatible);
        }

        // Order notes are single-use via the `consumed` flag (the asset-note nullifiers were
        // already recorded at lift). Mark both consumed atomically.
        a.consumed = true;
        b.consumed = true;
        env.storage().persistent().set(&DataKey::Entry(id_a), &a);
        env.storage().persistent().set(&DataKey::Entry(id_b), &b);

        // Construct proceeds from bound fields: (asset_out, fill_amount, output_owner_tag) per side.
        // The proceeds leaf = Poseidon(asset_out, fill_amount, output_owner_tag) is rebuilt
        // off-chain by the indexer/wallet; the contract emits the authenticated descriptor.
        env.events().publish(
            (symbol_short!("settled"),),
            (
                a.asset_out,
                b.amount_in,
                a.output_owner_tag.clone(),
                b.asset_out,
                a.amount_in,
                b.output_owner_tag.clone(),
            ),
        );

        Ok(())
    }
}

impl Settlement {
    /// Require the stored admin's authorization for a privileged call.
    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::VkNotSet)?;
        admin.require_auth();
        Ok(())
    }
}

/// Copy the 32-byte big-endian word at byte `off` out of the public-input blob.
/// Callers must ensure `off + 32 <= public_inputs.len()` (lift checks the total length first).
fn read_word(pi: &Bytes, off: u32) -> [u8; 32] {
    let mut buf = [0u8; 32];
    pi.slice(off..off + 32).copy_into_slice(&mut buf);
    buf
}

/// Interpret a field-element word as a u32, rejecting anything that does not fit the low 4 bytes.
fn word_to_u32(w: &[u8; 32]) -> Result<u32, Error> {
    let mut i = 0;
    while i < 28 {
        if w[i] != 0 {
            return Err(Error::FieldOverflow);
        }
        i += 1;
    }
    Ok(u32::from_be_bytes([w[28], w[29], w[30], w[31]]))
}

/// Interpret a field-element word as a non-negative i128, rejecting anything outside [0, 2^127).
fn word_to_i128(w: &[u8; 32]) -> Result<i128, Error> {
    let mut i = 0;
    while i < 16 {
        if w[i] != 0 {
            return Err(Error::FieldOverflow);
        }
        i += 1;
    }
    let mut b = [0u8; 16];
    b.copy_from_slice(&w[16..32]);
    let v = i128::from_be_bytes(b);
    if v < 0 {
        return Err(Error::FieldOverflow);
    }
    Ok(v)
}
