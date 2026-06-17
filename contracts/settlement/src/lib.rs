#![no_std]
//! Settlement spike: verify-at-lift, settle-cheap (see docs/settlement-design.md).
//!
//! `lift`  = VERIFY the spend proof (UltraHonk, native BN254 host fns) and only then store a
//!           validated pool entry. The stored nullifier is taken from the proof's public
//!           inputs, so it is bound to the proof (partial soundness invariant 1; the spike
//!           circuit does not yet bind asset/amount/price/output - that is the open item).
//! `settle`= consume TWO pre-verified pool entries with NO proof verification: price check,
//!           nullifier check + insert, emit the pre-committed output commitments. Atomic.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, Bytes, BytesN, Env};
use ultrahonk_soroban_verifier::{UltraHonkVerifier, PROOF_BYTES};

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
}

#[contracttype]
#[derive(Clone)]
pub struct PoolEntry {
    pub nullifier: BytesN<32>,
    pub asset_in: u32,
    pub amount_in: i128,
    pub asset_out: u32,
    pub min_out: i128,
    pub out_commitment: BytesN<32>,
    pub consumed: bool,
}

#[contracttype]
pub enum DataKey {
    Vk,
    Entry(u32),
    Nullifier(BytesN<32>),
}

#[contract]
pub struct Settlement;

#[contractimpl]
impl Settlement {
    /// Store the UltraHonk verification key once at deploy (validated by parsing it).
    pub fn __constructor(env: Env, vk_bytes: Bytes) -> Result<(), Error> {
        let _ = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|_| Error::VkInvalid)?;
        env.storage().instance().set(&DataKey::Vk, &vk_bytes);
        Ok(())
    }

    /// Lift: VERIFY the spend proof, then store a validated pool entry. This is the real lift -
    /// nothing is stored unless the proof verifies against the deploy-time VK.
    pub fn lift(
        env: Env,
        id: u32,
        proof_bytes: Bytes,
        public_inputs: Bytes,
        asset_in: u32,
        amount_in: i128,
        asset_out: u32,
        min_out: i128,
        out_commitment: BytesN<32>,
    ) -> Result<(), Error> {
        // --- verification (the expensive part, ~80% of budget) ---
        if proof_bytes.len() as usize != PROOF_BYTES {
            return Err(Error::ProofParseError);
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

        // Bind the stored nullifier to the proof: it is the 3rd public input
        // (our circuit's public inputs are [txbind, root, nullifier], 32 bytes each).
        if public_inputs.len() < 96 {
            return Err(Error::ProofParseError);
        }
        let mut nf = [0u8; 32];
        public_inputs.slice(64..96).copy_into_slice(&mut nf);
        let nullifier = BytesN::from_array(&env, &nf);

        // --- store validated entry ---
        let entry = PoolEntry {
            nullifier,
            asset_in,
            amount_in,
            asset_out,
            min_out,
            out_commitment,
            consumed: false,
        };
        env.storage().persistent().set(&DataKey::Entry(id), &entry);
        Ok(())
    }

    /// Settle: consume two pre-verified entries. NO proof verification.
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
        if a.asset_in != b.asset_out || a.asset_out != b.asset_in {
            return Err(Error::NotCompatible);
        }
        if a.amount_in < b.min_out || b.amount_in < a.min_out {
            return Err(Error::NotCompatible);
        }

        let nfa = DataKey::Nullifier(a.nullifier.clone());
        let nfb = DataKey::Nullifier(b.nullifier.clone());
        if env.storage().persistent().has(&nfa) || env.storage().persistent().has(&nfb) {
            return Err(Error::NullifierUsed);
        }
        env.storage().persistent().set(&nfa, &true);
        env.storage().persistent().set(&nfb, &true);

        a.consumed = true;
        b.consumed = true;
        env.storage().persistent().set(&DataKey::Entry(id_a), &a);
        env.storage().persistent().set(&DataKey::Entry(id_b), &b);
        env.events()
            .publish((symbol_short!("settled"),), (a.out_commitment, b.out_commitment));

        Ok(())
    }
}
