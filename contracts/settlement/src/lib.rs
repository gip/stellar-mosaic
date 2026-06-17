#![no_std]
//! Settlement spike: verify-at-lift, settle-cheap (see docs/settlement-design.md).
//!
//! `lift`  = (PRODUCTION: verify spend proof ~79.9M, then) store a validated pool entry.
//!           This spike measures the STORE path; the verify cost is the separately-measured
//!           79.9M from the UltraHonk verifier.
//! `settle`= consume TWO pre-verified pool entries with NO proof verification: price check,
//!           nullifier check + insert, emit the pre-committed output commitments. Atomic.
//!
//! Goal: confirm `settle` (the no-verify path) is far under the ~100M per-tx Soroban budget,
//! so that splitting one expensive verify per `lift` tx makes a two-sided trade feasible.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, BytesN, Env};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    EntryNotFound = 1,
    AlreadyConsumed = 2,
    NullifierUsed = 3,
    NotCompatible = 4,
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
    Entry(u32),
    Nullifier(BytesN<32>),
}

#[contract]
pub struct Settlement;

#[contractimpl]
impl Settlement {
    /// Lift: store a validated pool entry. In production this is preceded by a spend-proof
    /// verification (~79.9M). The proof MUST bind every field below (soundness invariant 1).
    pub fn lift(
        env: Env,
        id: u32,
        nullifier: BytesN<32>,
        asset_in: u32,
        amount_in: i128,
        asset_out: u32,
        min_out: i128,
        out_commitment: BytesN<32>,
    ) {
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

        // Price compatibility: a sells asset_in wanting asset_out; b is the mirror.
        if a.asset_in != b.asset_out || a.asset_out != b.asset_in {
            return Err(Error::NotCompatible);
        }
        if a.amount_in < b.min_out || b.amount_in < a.min_out {
            return Err(Error::NotCompatible);
        }

        // Double-spend check + insert (no verify needed: the proofs were checked at lift).
        let nfa = DataKey::Nullifier(a.nullifier.clone());
        let nfb = DataKey::Nullifier(b.nullifier.clone());
        if env.storage().persistent().has(&nfa) || env.storage().persistent().has(&nfb) {
            return Err(Error::NullifierUsed);
        }
        env.storage().persistent().set(&nfa, &true);
        env.storage().persistent().set(&nfb, &true);

        // Emit the pre-committed output commitments (the settlement outputs).
        a.consumed = true;
        b.consumed = true;
        env.storage().persistent().set(&DataKey::Entry(id_a), &a);
        env.storage().persistent().set(&DataKey::Entry(id_b), &b);
        env.events()
            .publish((symbol_short!("settled"),), (a.out_commitment, b.out_commitment));

        Ok(())
    }
}
