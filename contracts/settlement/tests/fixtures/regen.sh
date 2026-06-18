#!/usr/bin/env bash
# Regenerate the integration-test proof fixtures from circuits/lift.
#
# These are real UltraHonk artifacts (one VK + two proofs for two crossing orders) committed so
# `cargo test` runs the genuine verifier with no Noir/bb toolchain. Re-run this only if the lift
# circuit or its public-input layout changes. Requires the pinned toolchain (see README):
#   nargo 1.0.0-beta.9, bb v0.87.0 on PATH.
#
# Order A: offer 100 of asset 1, want >= 1500 of asset 2   (tags 9001 / 9002)
# Order B: offer 2000 of asset 2, want >= 50 of asset 1    (tags 9003 / 9004)
# A and B cross. The two orders use different (sk_o, rho_in) so their nullifiers differ.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
LIFT="$ROOT/circuits/lift"
OUT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.nargo/bin:$HOME/.bb:$PATH"

prove() { # $1=label  (uses circuits/lift/Prover.toml already set to the order)
  cd "$LIFT"
  nargo execute
  bb prove    -b target/lift.json -w target/lift.gz -o target \
    --scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields
  bb write_vk -b target/lift.json -o target \
    --scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields
  if [ -d target/vk ] && [ -f target/vk/vk ]; then
    mv target/vk/vk target/vk.tmp && rmdir target/vk && mv target/vk.tmp target/vk
  fi
  cp target/proof "$OUT/proof_$1"
  cp target/public_inputs "$OUT/public_inputs_$1"
  cp target/vk "$OUT/vk"   # same circuit -> same VK for both orders
}

echo "NOTE: this script assumes circuits/lift/Prover.toml is populated for each order in turn."
echo "See the order parameters in the header; the committed fixtures were produced this way."
echo "Regeneration is manual per order because the witness (sk_o, rho_in, path) is chosen by hand."
echo "Build order A's Prover.toml, run 'prove a'; build order B's, run 'prove b'."
echo
echo "UNSHIELD fixtures (unshield_vk / unshield_proof / unshield_public_inputs):"
echo " - produced from circuits/unshield with bb (same flags)."
echo " - the proof binds recipient = sha256(to.to_xdr()) (top byte zeroed) for the fixed test"
echo "   address UNSHIELD_TO in tests/integration.rs. To rebind to a different address, print that"
echo "   address's recipient field with a one-off test (env.crypto().sha256(to.to_xdr()), zero byte"
echo "   0), set it as circuits/unshield/Prover.toml recipient, regenerate, and update UNSHIELD_TO."
