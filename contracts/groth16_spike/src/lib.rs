#![no_std]
//! BN254 Groth16 verifier on the Soroban host — spike.
//!
//! Purpose: de-risk Workstream 3 of the Base-shield bridge (`docs/base-bridge.md`). A RISC Zero /
//! Boundless receipt is a Groth16 proof over BN254; to mint a note on Stellar from a Base deposit we
//! must verify that proof inside the settlement contract. This crate proves the verify is (a) doable
//! with the Soroban host's native BN254 functions and (b) cheap enough for the 400M per-tx budget.
//!
//! It implements the standard Groth16 check (Groth 2016 / arkworks / snarkjs convention)
//!
//! ```text
//!   e(A, B) == e(alpha, beta) · e(vk_x, gamma) · e(C, delta)
//!   vk_x   = IC[0] + Σ_i  public_i · IC[i+1]
//! ```
//!
//! rearranged into a single multi-pairing product that the host can check against 1:
//!
//! ```text
//!   e(-A, B) · e(alpha, beta) · e(vk_x, gamma) · e(C, delta) == 1
//! ```
//!
//! All points use the host's Ethereum-compatible encoding (G1 = be(x)||be(y), 64 bytes; G2 =
//! be(x.c1)||be(x.c0)||be(y.c1)||be(y.c0), 128 bytes). Public inputs are big-endian field elements.
//! The real RISC Zero verifier (Workstream 4) reuses this exact routine; only the VK constants and
//! the public-input derivation (control root + claim digest split + bn254 control id) sit on top.

use soroban_sdk::{
    contract, contractimpl, contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
    BytesN, Env, Vec, U256,
};

/// Groth16 verifying key, points in the host's Ethereum encoding.
#[contracttype]
#[derive(Clone)]
pub struct Vk {
    pub alpha: BytesN<64>,    // G1
    pub beta: BytesN<128>,    // G2
    pub gamma: BytesN<128>,   // G2
    pub delta: BytesN<128>,   // G2
    pub ic: Vec<BytesN<64>>,  // G1[]; len == num_public_inputs + 1
}

/// Groth16 proof (A in G1, B in G2, C in G1).
#[contracttype]
#[derive(Clone)]
pub struct Proof {
    pub a: BytesN<64>,   // G1
    pub b: BytesN<128>,  // G2
    pub c: BytesN<64>,   // G1
}

/// Verify a Groth16 proof. `public_inputs` are big-endian BN254 scalar-field elements. Returns
/// `false` on a structural mismatch (IC length) or a failed pairing. Off-curve / malformed points
/// cause the host to trap (a hostile proof can only make this revert, never wrongly accept).
pub fn verify_groth16(
    env: &Env,
    vk: &Vk,
    proof: &Proof,
    public_inputs: &Vec<BytesN<32>>,
) -> bool {
    // IC must carry exactly one base point plus one per public input.
    if vk.ic.len() != public_inputs.len() + 1 {
        return false;
    }
    let bn = env.crypto().bn254();

    // vk_x = IC[0]·1 + Σ public_i · IC[i+1]   (single host MSM)
    let mut points: Vec<Bn254G1Affine> = Vec::new(env);
    let mut scalars: Vec<Bn254Fr> = Vec::new(env);
    points.push_back(Bn254G1Affine::from_bytes(vk.ic.get_unchecked(0)));
    scalars.push_back(Bn254Fr::from_u256(U256::from_u32(env, 1)));
    for i in 0..public_inputs.len() {
        points.push_back(Bn254G1Affine::from_bytes(vk.ic.get_unchecked(i + 1)));
        scalars.push_back(Bn254Fr::from_bytes(public_inputs.get_unchecked(i)));
    }
    let vk_x = bn.g1_msm(points, scalars);

    // e(-A,B) · e(alpha,beta) · e(vk_x,gamma) · e(C,delta) == 1
    let neg_a = -Bn254G1Affine::from_bytes(proof.a.clone());
    let mut g1s: Vec<Bn254G1Affine> = Vec::new(env);
    let mut g2s: Vec<Bn254G2Affine> = Vec::new(env);
    g1s.push_back(neg_a);
    g2s.push_back(Bn254G2Affine::from_bytes(proof.b.clone()));
    g1s.push_back(Bn254G1Affine::from_bytes(vk.alpha.clone()));
    g2s.push_back(Bn254G2Affine::from_bytes(vk.beta.clone()));
    g1s.push_back(vk_x);
    g2s.push_back(Bn254G2Affine::from_bytes(vk.gamma.clone()));
    g1s.push_back(Bn254G1Affine::from_bytes(proof.c.clone()));
    g2s.push_back(Bn254G2Affine::from_bytes(vk.delta.clone()));

    bn.pairing_check(g1s, g2s)
}

#[contract]
pub struct Groth16Spike;

#[contractimpl]
impl Groth16Spike {
    /// Thin contract wrapper so the test exercises the verify through a real contract invocation
    /// (and thus a realistic metered budget), exactly as the settlement contract will call it.
    pub fn verify(env: Env, vk: Vk, proof: Proof, public_inputs: Vec<BytesN<32>>) -> bool {
        verify_groth16(&env, &vk, &proof, &public_inputs)
    }
}
