#![no_std]
//! Merged Desk + custody contract. Single contract owns custody, the nullifier registry, matching,
//! and settlement. See docs/architecture.md, docs/lift-circuit-spec.md.
//!
//! `shield`  = move a real Soroban token into custody and mint an AssetNote. Proof-free: amounts are
//!             public and the token transfer enforces the amount, so conservation needs no ZK.
//!             Emits the note fields; the off-chain tree builder ingests them and publishes the root.
//! `settle`  = ATOMIC two-sided trade in ONE tx. Verifies BOTH parties' order proofs (the lift
//!             circuit: each proves the party owns an asset note in the tree, reveals its nullifier,
//!             and commits to its order terms), checks the orders cross in plaintext from the bound
//!             public inputs, records both nullifiers, and emits proceeds. No resting on-chain order
//!             entries, no separate lift step: two crossing order proofs are matched off-chain and
//!             settled together here. Feasible because two UltraHonk verifies (~160M) fit the 400M
//!             per-tx budget (see docs/tx-instruction-limit-spike.md).
//! `unshield`= spend an asset note with a proof and transfer the real token out, with the recipient
//!             bound into the proof so a relayer cannot redirect it.
//!
//! Order-proof public-input vector (lift circuit, 10 x 32-byte big-endian field elements):
//!   [0] domain  [1] root  [2] nullifier_in  [3] asset_in  [4] amount_in  [5] asset_out
//!   [6] min_out [7] output_owner_tag  [8] cancel_owner_tag  [9] order_leaf
//! settle uses [0..8]; cancel_owner_tag/order_leaf are unused here (no on-chain order note).

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token::TokenClient,
    xdr::ToXdr, Address, Bytes, BytesN, Env,
};
use ultrahonk_soroban_verifier::{UltraHonkVerifier, PROOF_BYTES};

/// Operation ids: also index the per-operation verification keys (`DataKey::Vk(op)`) and match the
/// circuit domain separators (lift/order circuit domain = 1, unshield circuit domain = 2).
const LIFT_OP: u32 = 1;
const UNSHIELD_OP: u32 = 2;

/// Public-input lengths for the order (lift) circuit and the unshield circuit.
const LIFT_PUBLIC_INPUTS_BYTES: u32 = 10 * 32;
const UNSHIELD_PUBLIC_INPUTS_BYTES: u32 = 6 * 32;
/// Domain separators as 32-byte big-endian field words: order/lift = 1, unshield = 2.
const LIFT_DOMAIN: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
];
const UNSHIELD_DOMAIN: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
];

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    // 1 and 2 are reserved (formerly EntryNotFound / AlreadyConsumed from the two-phase
    // lift+settle design, removed in the atomic-settle refactor). Kept to preserve discriminants.
    Reserved1 = 1,
    Reserved2 = 2,
    NullifierUsed = 3,
    NotCompatible = 4,
    VkNotSet = 5,
    VkInvalid = 6,
    ProofParseError = 7,
    VerificationFailed = 8,
    BadPublicInputs = 9, // wrong public-input length or wrong domain separator
    UnknownRoot = 10,    // root not in the published root history
    FieldOverflow = 11,  // a field element did not fit the expected u32/i128 range
    AssetNotRegistered = 12, // no token contract mapped to this asset id
    InvalidAmount = 13,      // shield/unshield amount must be positive
    AssetAlreadyRegistered = 14, // asset id already mapped (admin must not silently rebind)
    RecipientMismatch = 15,  // unshield payout address does not match the proof-bound recipient
}

#[contracttype]
pub enum DataKey {
    Vk(u32), // verification key per operation (LIFT_OP / UNSHIELD_OP)
    Admin,
    Root(BytesN<32>),
    Nullifier(BytesN<32>),
    Asset(u32), // asset id -> token contract Address
}

/// One verified side of a trade, derived entirely from a verified order proof's public inputs.
struct Order {
    nullifier: BytesN<32>,
    asset_in: u32,
    amount_in: i128,
    asset_out: u32,
    min_out: i128,
    output_owner_tag: BytesN<32>,
}

#[contract]
pub struct Settlement;

#[contractimpl]
impl Settlement {
    /// Store the order (lift) UltraHonk verification key (validated by parsing) and the admin. The
    /// unshield VK is registered separately via `set_vk(UNSHIELD_OP, ..)` (a different circuit).
    pub fn __constructor(env: Env, vk_bytes: Bytes, admin: Address) -> Result<(), Error> {
        let _ = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|_| Error::VkInvalid)?;
        env.storage().instance().set(&DataKey::Vk(LIFT_OP), &vk_bytes);
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    /// Register the verification key for an operation (e.g. UNSHIELD_OP). Admin-gated and validated
    /// by parsing. Each operation is a distinct circuit, so it needs its own VK.
    pub fn set_vk(env: Env, op: u32, vk_bytes: Bytes) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let _ = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|_| Error::VkInvalid)?;
        env.storage().instance().set(&DataKey::Vk(op), &vk_bytes);
        Ok(())
    }

    /// Publish a Merkle root produced by the off-chain tree rebuild. Order/unshield proofs may be
    /// made against any published root. Admin-gated (the off-chain tree publisher). Staleness /
    /// bounded-ring eviction is a later refinement; double-spend safety comes from nullifiers.
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

    /// Settle: an atomic two-sided trade in one transaction. The caller (an off-chain matcher)
    /// supplies both parties' order proofs. The contract verifies both, derives each order entirely
    /// from its verified public inputs (nothing the caller passes is trusted), checks they cross,
    /// records both nullifiers, and emits the proceeds descriptors stamped with each order's bound
    /// `output_owner_tag`. No on-chain order entries; no caller-supplied output commitments.
    pub fn settle(
        env: Env,
        proof_a: Bytes,
        public_inputs_a: Bytes,
        proof_b: Bytes,
        public_inputs_b: Bytes,
    ) -> Result<(), Error> {
        // Verify BOTH order proofs (~80M each; ~160M total fits the 400M per-tx budget).
        Self::verify_proof(&env, LIFT_OP, &proof_a, &public_inputs_a, LIFT_PUBLIC_INPUTS_BYTES)?;
        Self::verify_proof(&env, LIFT_OP, &proof_b, &public_inputs_b, LIFT_PUBLIC_INPUTS_BYTES)?;

        // Derive each side from its verified public inputs (domain + published-root checked here).
        let a = parse_order(&env, &public_inputs_a)?;
        let b = parse_order(&env, &public_inputs_b)?;

        // Assets must cross: A offers what B wants and vice versa.
        if a.asset_in != b.asset_out || a.asset_out != b.asset_in {
            return Err(Error::NotCompatible);
        }
        // Full-fill v1: each side receives the other's offered amount; both limits must be met.
        // A receives b.amount_in of a.asset_out; B receives a.amount_in of b.asset_out.
        if a.amount_in < b.min_out || b.amount_in < a.min_out {
            return Err(Error::NotCompatible);
        }
        // The two sides must be distinct notes (cannot cross a note against itself).
        if a.nullifier == b.nullifier {
            return Err(Error::NotCompatible);
        }

        // Both consumed notes must be unspent; record both nullifiers atomically before outputs.
        let ka = DataKey::Nullifier(a.nullifier.clone());
        let kb = DataKey::Nullifier(b.nullifier.clone());
        if env.storage().persistent().has(&ka) || env.storage().persistent().has(&kb) {
            return Err(Error::NullifierUsed);
        }
        env.storage().persistent().set(&ka, &true);
        env.storage().persistent().set(&kb, &true);

        // Proceeds: (asset_out, fill_amount, output_owner_tag) per side, stamped from the bound
        // tags. The proceeds leaf Poseidon(asset_out, fill_amount, output_owner_tag) is rebuilt
        // off-chain by the indexer/wallet; the contract emits the authenticated descriptor.
        env.events().publish(
            (symbol_short!("settled"),),
            (
                a.asset_out,
                b.amount_in,
                a.output_owner_tag,
                b.asset_out,
                a.amount_in,
                b.output_owner_tag,
            ),
        );
        Ok(())
    }

    /// Unshield: spend an asset note with a proof and transfer the real token out to `to`.
    /// The proof binds the withdrawal recipient (public input [5] == sha256-derived field of `to`),
    /// so a relayer can submit this without being able to redirect the funds. No caller auth is
    /// needed: the proof is the spend authority and the recipient is fixed by the proof.
    ///
    /// Public inputs: [0] domain [1] root [2] nullifier [3] asset [4] amount [5] recipient.
    pub fn unshield(
        env: Env,
        to: Address,
        proof_bytes: Bytes,
        public_inputs: Bytes,
    ) -> Result<(), Error> {
        Self::verify_proof(
            &env,
            UNSHIELD_OP,
            &proof_bytes,
            &public_inputs,
            UNSHIELD_PUBLIC_INPUTS_BYTES,
        )?;

        // [0] domain separator must be the unshield constant.
        if read_word(&public_inputs, 0) != UNSHIELD_DOMAIN {
            return Err(Error::BadPublicInputs);
        }
        // [1] root must be a published root.
        let root = BytesN::from_array(&env, &read_word(&public_inputs, 32));
        if !env.storage().persistent().has(&DataKey::Root(root)) {
            return Err(Error::UnknownRoot);
        }
        // [2] nullifier of the spent asset note: must be unused.
        let nullifier = BytesN::from_array(&env, &read_word(&public_inputs, 64));
        let nf_key = DataKey::Nullifier(nullifier.clone());
        if env.storage().persistent().has(&nf_key) {
            return Err(Error::NullifierUsed);
        }
        // [3..5] withdrawal terms.
        let asset = word_to_u32(&read_word(&public_inputs, 96))?;
        let amount = word_to_i128(&read_word(&public_inputs, 128))?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        // [5] recipient binding: the proof must commit to exactly this payout address.
        if read_word(&public_inputs, 160) != recipient_field(&env, &to) {
            return Err(Error::RecipientMismatch);
        }

        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Asset(asset))
            .ok_or(Error::AssetNotRegistered)?;

        // Record the nullifier BEFORE paying out (single-use; spend cannot be replayed), then
        // transfer the public amount of the real token to the proof-bound recipient.
        env.storage().persistent().set(&nf_key, &true);
        TokenClient::new(&env, &token).transfer(&env.current_contract_address(), &to, &amount);

        env.events()
            .publish((symbol_short!("unshield"),), (asset, amount, nullifier));
        Ok(())
    }
}

impl Settlement {
    /// Verify a proof for `op` against its stored VK, after length-checking the proof and public
    /// inputs. Shared by `settle` (both sides) and `unshield`.
    fn verify_proof(
        env: &Env,
        op: u32,
        proof_bytes: &Bytes,
        public_inputs: &Bytes,
        expected_pi_bytes: u32,
    ) -> Result<(), Error> {
        if proof_bytes.len() as usize != PROOF_BYTES {
            return Err(Error::ProofParseError);
        }
        if public_inputs.len() != expected_pi_bytes {
            return Err(Error::BadPublicInputs);
        }
        let vk_bytes: Bytes = env
            .storage()
            .instance()
            .get(&DataKey::Vk(op))
            .ok_or(Error::VkNotSet)?;
        let verifier = UltraHonkVerifier::new(env, &vk_bytes).map_err(|_| Error::VkInvalid)?;
        verifier
            .verify(env, proof_bytes, public_inputs)
            .map_err(|_| Error::VerificationFailed)?;
        Ok(())
    }

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

/// Derive one order side from a VERIFIED order-proof public-input blob. Checks the lift domain
/// separator and that the membership root is published; parses the order terms the proof bound.
/// Caller must have verified the proof first.
fn parse_order(env: &Env, pi: &Bytes) -> Result<Order, Error> {
    // [0] domain separator must be the order/lift constant.
    if read_word(pi, 0) != LIFT_DOMAIN {
        return Err(Error::BadPublicInputs);
    }
    // [1] root must be a published root.
    let root = BytesN::from_array(env, &read_word(pi, 32));
    if !env.storage().persistent().has(&DataKey::Root(root)) {
        return Err(Error::UnknownRoot);
    }
    Ok(Order {
        nullifier: BytesN::from_array(env, &read_word(pi, 64)),
        asset_in: word_to_u32(&read_word(pi, 96))?,
        amount_in: word_to_i128(&read_word(pi, 128))?,
        asset_out: word_to_u32(&read_word(pi, 160))?,
        min_out: word_to_i128(&read_word(pi, 192))?,
        output_owner_tag: BytesN::from_array(env, &read_word(pi, 224)),
    })
}

/// Deterministically map a payout address to the BN254 field the unshield proof must bind as its
/// recipient. We hash the address's XDR with sha256 and zero the top byte so the value is < 2^248
/// (safely below the field modulus). The wallet computes the identical value off-chain and bakes it
/// into the proof, so the contract can confirm the proof was made for exactly this `to`.
fn recipient_field(env: &Env, to: &Address) -> [u8; 32] {
    let h = env.crypto().sha256(&to.clone().to_xdr(env)).to_array();
    let mut w = [0u8; 32];
    let mut i = 1;
    while i < 32 {
        w[i] = h[i];
        i += 1;
    }
    w
}

/// Copy the 32-byte big-endian word at byte `off` out of the public-input blob.
/// Callers must ensure `off + 32 <= public_inputs.len()` (verify_proof checks the total length).
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
