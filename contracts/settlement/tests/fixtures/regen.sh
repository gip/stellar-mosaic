#!/usr/bin/env bash
# Regenerate the integration-test proof fixtures from circuits/lift + circuits/unshield.
#
# These are real UltraHonk artifacts (one VK + two crossing order proofs + one unshield proof)
# committed so `cargo test` runs the genuine verifier with no Noir/bb toolchain. Re-run this only if
# a circuit or its public-input layout changes. Requires the pinned toolchain (see README):
#   nargo 1.0.0-beta.9, bb v0.87.0 on PATH.
#
# Order A: offer 100 of asset 1, want >= 1500 of asset 2   (tags 9001 / 9002)
# Order B: offer 2000 of asset 2, want >= 50 of asset 1    (tags 9003 / 9004)
# A and B cross. The two orders use different (sk_o, rho_in) so their nullifiers differ.
#
# THE TREE WITNESS IS NO LONGER HAND-BUILT. The `path` / `index_bits` in each Prover.toml are
# derived by the off-chain path server (tools/indexer, the `witness` bin) from the SAME shield
# sequence the on-chain tree sees, so the proofs are made against the exact root the contract
# produces. To (re)derive a witness, replay the shields and ask for the leaf you are proving:
#
#   # owner_tag_a / owner_tag_b are the public note tags committed in the fixtures.
#   OTA=$(xxd -p -c64 owner_tag_a); OTB=$(xxd -p -c64 owner_tag_b)
#   printf 'shield 1 100 %s\nshield 2 2000 %s\npath 0\npath 1\n' "$OTA" "$OTB" \
#     | ( cd ../../../../tools/indexer && cargo run -q --bin witness )
#
#   # path 0 -> order A's witness (leaf index 0); path 1 -> order B's witness (leaf index 1).
#   # Copy the printed `root`, `path` and `index_bits` lines into the matching circuits/*/Prover.toml.
#   # For the unshield note (shield 1 100 owner_tag_u, index 0):
#   #   OTU=$(xxd -p -c64 owner_tag_u)
#   #   printf 'shield 1 100 %s\npath 0\n' "$OTU" | ( cd ../../../../tools/indexer && cargo run -q --bin witness )
#
# The remaining witness fields (rho_in, sk_o, asset/amount/tags, nullifier_in, order_leaf, recipient)
# are still chosen per order; the indexer only supplies the membership witness (path/index_bits/root).
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

echo "1. Derive each order's membership witness with the path server (see the header comment),"
echo "   and paste the printed root/path/index_bits into circuits/lift/Prover.toml for that order."
echo "2. Set the rest of Prover.toml for the order, then run 'prove a' (order A) / 'prove b' (order B)."
echo
echo "EXACT-REVERSE fixtures (proof_exa/b, public_inputs_exa/b, owner_tag_exa/b) for settle_exact:"
echo " - same lift circuit/VK; two orders that are EXACT reverses (no surplus):"
echo "     A: offer 100 of asset 1, want EXACTLY 2000 of asset 2  (sk_o 1001 / rho_in 2001, tags 9001/9002)"
echo "     B: offer 2000 of asset 2, want EXACTLY 100 of asset 1   (sk_o 1003 / rho_in 2003, tags 9003/9004)"
echo " - derive the per-order owner tag, membership witness, nullifier and order_leaf via the witness bin:"
echo "     OTA=\$(printf 'notetag 1001 2001\\n' | (cd ../../../../tools/indexer && cargo run -q --bin witness))"
echo "     OTB=\$(printf 'notetag 1003 2003\\n' | (cd ../../../../tools/indexer && cargo run -q --bin witness))"
echo "     printf 'shield 1 100 %s\\nshield 2 2000 %s\\npath 0\\npath 1\\n' \"\$OTA\" \"\$OTB\" | (cd .../tools/indexer && cargo run -q --bin witness)"
echo "     printf 'nullifier 1001 2001\\nnullifier 1003 2003\\n'                | (cd .../tools/indexer && cargo run -q --bin witness)"
echo "     printf 'orderleaf 1 100 2 2000 9001 9002 9999999999 0\\norderleaf 2 2000 1 100 9003 9004 9999999999 0\\n' | (cd .../tools/indexer && cargo run -q --bin witness)"
echo "   (orderleaf is now hash8: ... <out_tag> <cancel_tag> <expiry> <partial_allowed>; lift has 12 public inputs)"
echo " - set circuits/lift/Prover.toml for each order (incl. expiry + partial_allowed), 'prove exa' / 'prove exb', and write owner_tag_exa/b"
echo "   as the raw 32 bytes of OTA/OTB (xxd -r -p). The VK is identical to fixtures/vk (same circuit)."
echo
echo "UNSHIELD fixtures (unshield_vk / unshield_proof / unshield_public_inputs):"
echo " - produced from circuits/unshield with bb (same flags); membership witness derived the same"
echo "   way via the witness bin (shield the unshield note, ask for its leaf index)."
echo " - the proof binds recipient = sha256(to.to_xdr()) (top byte zeroed) for the fixed test"
echo "   address UNSHIELD_TO in tests/integration.rs. To rebind to a different address, print that"
echo "   address's recipient field with a one-off test (env.crypto().sha256(to.to_xdr()), zero byte"
echo "   0), set it as circuits/unshield/Prover.toml recipient, regenerate, and update UNSHIELD_TO."
