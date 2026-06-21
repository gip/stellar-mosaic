//! End-to-end spike: generate a REAL Groth16/BN254 proof off-chain with arkworks, verify it on the
//! Soroban host, and measure CPU. This is the load-bearing evidence for Workstream 3 — that a RISC
//! Zero receipt (a Groth16 proof) can be verified inside the settlement contract within budget.

use ark_bn254::{Bn254, Fq, Fq2, Fr as ArkFr, G1Affine, G2Affine};
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::Groth16;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_relations::lc;
use ark_snark::SNARK;
use soroban_sdk::{vec, BytesN, Env, Vec as SVec};

use groth16_spike::{Groth16Spike, Groth16SpikeClient, Proof, Vk};

/// Toy circuit: prove knowledge of (a, b) with a·b == c, where c is the single public input.
#[derive(Clone)]
struct MulCircuit {
    a: Option<ArkFr>,
    b: Option<ArkFr>,
}

impl ConstraintSynthesizer<ArkFr> for MulCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<ArkFr>) -> Result<(), SynthesisError> {
        let a = cs.new_witness_variable(|| self.a.ok_or(SynthesisError::AssignmentMissing))?;
        let b = cs.new_witness_variable(|| self.b.ok_or(SynthesisError::AssignmentMissing))?;
        let c = cs.new_input_variable(|| {
            let a = self.a.ok_or(SynthesisError::AssignmentMissing)?;
            let b = self.b.ok_or(SynthesisError::AssignmentMissing)?;
            Ok(a * b)
        })?;
        cs.enforce_constraint(lc!() + a, lc!() + b, lc!() + c)?;
        Ok(())
    }
}

// ---- encoding helpers: arkworks field/point -> host Ethereum byte layout ----

fn fq_be(f: &Fq) -> [u8; 32] {
    let v = f.into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - v.len()..].copy_from_slice(&v);
    out
}

fn fr_be(f: &ArkFr) -> [u8; 32] {
    let v = f.into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - v.len()..].copy_from_slice(&v);
    out
}

fn g1_be(p: &G1Affine) -> [u8; 64] {
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&fq_be(&p.x));
    out[32..].copy_from_slice(&fq_be(&p.y));
    out
}

// G2 in Ethereum order: be(x.c1) || be(x.c0) || be(y.c1) || be(y.c0)  (imaginary component first).
fn g2_be(p: &G2Affine) -> [u8; 128] {
    let x: &Fq2 = &p.x;
    let y: &Fq2 = &p.y;
    let mut out = [0u8; 128];
    out[0..32].copy_from_slice(&fq_be(&x.c1));
    out[32..64].copy_from_slice(&fq_be(&x.c0));
    out[64..96].copy_from_slice(&fq_be(&y.c1));
    out[96..128].copy_from_slice(&fq_be(&y.c0));
    out
}

struct Fixture {
    vk: Vk,
    proof: Proof,
    public_inputs: SVec<BytesN<32>>,
    c: ArkFr,
}

fn build_fixture(env: &Env) -> Fixture {
    use ark_std::rand::SeedableRng;
    let mut rng = ark_std::rand::rngs::StdRng::seed_from_u64(0);
    let a = ArkFr::from(3u64);
    let b = ArkFr::from(11u64);
    let c = a * b;

    let (pk, ark_vk) = Groth16::<Bn254>::circuit_specific_setup(
        MulCircuit { a: None, b: None },
        &mut rng,
    )
    .unwrap();
    let ark_proof = Groth16::<Bn254>::prove(
        &pk,
        MulCircuit { a: Some(a), b: Some(b) },
        &mut rng,
    )
    .unwrap();

    // Off-chain sanity: arkworks itself accepts the proof before we trust the on-chain path.
    let pvk = Groth16::<Bn254>::process_vk(&ark_vk).unwrap();
    assert!(
        Groth16::<Bn254>::verify_with_processed_vk(&pvk, &[c], &ark_proof).unwrap(),
        "arkworks rejected its own proof"
    );

    let mut ic: SVec<BytesN<64>> = SVec::new(env);
    for g in ark_vk.gamma_abc_g1.iter() {
        ic.push_back(BytesN::from_array(env, &g1_be(g)));
    }
    let vk = Vk {
        alpha: BytesN::from_array(env, &g1_be(&ark_vk.alpha_g1)),
        beta: BytesN::from_array(env, &g2_be(&ark_vk.beta_g2)),
        gamma: BytesN::from_array(env, &g2_be(&ark_vk.gamma_g2)),
        delta: BytesN::from_array(env, &g2_be(&ark_vk.delta_g2)),
        ic,
    };
    let proof = Proof {
        a: BytesN::from_array(env, &g1_be(&ark_proof.a)),
        b: BytesN::from_array(env, &g2_be(&ark_proof.b)),
        c: BytesN::from_array(env, &g1_be(&ark_proof.c)),
    };
    let public_inputs = vec![env, BytesN::from_array(env, &fr_be(&c))];
    Fixture { vk, proof, public_inputs, c }
}

#[test]
fn groth16_verify_accepts_valid_proof_and_fits_budget() {
    let env = Env::default();
    let id = env.register(Groth16Spike, ());
    let client = Groth16SpikeClient::new(&env, &id);
    let f = build_fixture(&env);

    env.cost_estimate().budget().reset_unlimited();
    let ok = client.verify(&f.vk, &f.proof, &f.public_inputs);
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();

    assert!(ok, "host rejected a valid Groth16 proof");
    std::println!("groth16 verify CPU: {cpu} ({:.1}% of 400M)", cpu as f64 / 4_000_000.0);
    assert!(cpu < 400_000_000, "verify CPU {cpu} exceeds the 400M per-tx budget");
}

#[test]
fn groth16_verify_rejects_wrong_public_input() {
    let env = Env::default();
    let id = env.register(Groth16Spike, ());
    let client = Groth16SpikeClient::new(&env, &id);
    let f = build_fixture(&env);

    // A different (still valid) public input: c+1. Points stay on-curve, so the host returns false
    // rather than trapping — the clean soundness signal.
    let wrong = vec![&env, BytesN::from_array(&env, &fr_be(&(f.c + ArkFr::from(1u64))))];
    let ok = client.verify(&f.vk, &f.proof, &wrong);
    assert!(!ok, "host accepted a proof against the wrong public input");
}

#[test]
fn groth16_verify_rejects_tampered_ic_length() {
    let env = Env::default();
    let id = env.register(Groth16Spike, ());
    let client = Groth16SpikeClient::new(&env, &id);
    let f = build_fixture(&env);

    // Drop a public input so ic.len() != public.len()+1 -> structural reject.
    let empty: SVec<BytesN<32>> = SVec::new(&env);
    let ok = client.verify(&f.vk, &f.proof, &empty);
    assert!(!ok, "accepted a structurally invalid (IC length) input");
}
