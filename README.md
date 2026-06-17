# stellar-mosaic

A privacy-preserving DEX on Stellar. Trade resting offers without leaking who owns
what, with non-custodial atomic settlement. Built on Soroban smart contracts, Noir
circuits, and the [indextree UltraHonk Soroban verifier](https://github.com/indextree/ultrahonk_soroban_contract).

Design doc and eng plan live in `~/.gstack/projects/stellar-mosaic/`.

## Milestone 0 - on-chain verify spike (the gate)

The whole product rests on one unproven assumption: that a real-sized UltraHonk proof
can be verified **on Stellar testnet** within Soroban's resource limits. Milestone 0
proves (or disproves) that before any note/contract/app code gets written.

`circuits/spend` is a representative spend circuit (sizing spike, not the final scheme):
hash-lock authorization `owner_pk = Poseidon(sk)`, a depth-5 Merkle membership proof, a
nullifier `N = Poseidon(serial, nk)`, and a txbind binding.

### Status

| Step | State | Metric |
|------|-------|--------|
| Circuit compiles (nargo 1.0.0-beta.3) | DONE | - |
| Circuit size | DONE | **818 gates**, 45 ACIR opcodes |
| Prove + verify locally (bb 0.82.2) | DONE | proof **~14 KB**, vk **~1.8 KB** |
| Reject corrupted proof locally | DONE | rejected as expected |
| Verify on Stellar **testnet** | TODO | the actual gate |
| Two-verify-in-one-tx cost | TODO | the real budget question |

Run the validated local half:

```bash
./scripts/01_build_prove.sh
```

Run the on-chain half (has 3 `TODO(indextree)` reconciliation points to fill from the
verifier repo):

```bash
./scripts/02_deploy_verify_testnet.sh
```

### CRITICAL before the on-chain step: version pinning (CONFIRMED)

The verifier (`vendor/ultrahonk_soroban_contract/tests/build_circuits.sh`) pins:

| | required | installed here |
|--|----------|----------------|
| nargo | **1.0.0-beta.9** | 1.0.0-beta.3 |
| bb | **v0.87.0** | 0.82.2 |

Both must be bumped. **bb's proof format differs across versions** - a mismatch makes valid
proofs silently fail to verify. `scripts/02` installs the pinned pair into `~/.nargo` and
`~/.bb` and puts them first on PATH (this changes your global toolchain).

Confirmed artifact recipe (baked into `scripts/02`):
- `bb prove/write_vk --scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields`
  (the `bytes_and_fields` format emits the separate `public_inputs` file the contract needs).

Confirmed contract interface:
- VK is set ONCE at deploy via the constructor: `--vk_bytes-file-path target/vk`.
- Verify: `verify_proof --public_inputs-file-path ... --proof_bytes-file-path ...`.
- Build: `stellar contract build --optimize`, target `wasm32v1-none`.

## Layout

```
circuits/spend/      Noir spend circuit (Milestone 0 sizing spike)
scripts/             01 = local prove/verify (validated); 02 = on-chain (TODO markers)
docs/                milestone-0-results.md (record on-chain metrics here)
vendor/              indextree verifier, cloned + pinned (gitignored)
artifacts/           proof + vk outputs (gitignored)
```

## Not in scope yet

Everything past Milestone 0: notes/pool/matching, relayer, web, iOS. See the eng plan's
"NOT in scope" and "Open Questions" sections.
