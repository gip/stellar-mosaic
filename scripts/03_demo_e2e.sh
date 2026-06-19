#!/usr/bin/env bash
# End-to-end demo: generate a self-consistent set of REAL UltraHonk proofs for a full
# shield -> order -> settle -> unshield lifecycle, with every membership witness derived by the
# off-chain path server (tools/indexer `witness` bin). The proofs land in
# contracts/settlement/tests/fixtures/demo/ and are then executed against the contract on the local
# Soroban host by `cargo test --test e2e_demo` (run this script first, then that test).
#
# The scenario (all secrets are explicit so A can later spend the note it RECEIVES from the trade):
#   - A shields 100 of asset 1 (note keys skA/rhoA)            -> tree leaf 0
#   - B shields 2000 of asset 2 (note keys skB/rhoB)           -> tree leaf 1   (root = R2)
#   - A's order: give 100 asset1, want >=1500 asset2, proceeds to A's stealth tag otA_out
#   - B's order: give 2000 asset2, want >=50 asset1,  proceeds to B's stealth tag otB_out
#   - settle(A,B): A receives 2000 asset2 (leaf 2), B receives 100 asset1 (leaf 3)  (root = R4)
#   - A UNSHIELDS its proceeds note (leaf 2, the SETTLE-created note) to a real address.
#     This is the step only the path server makes possible: leaf 2's path is reconstructed from the
#     shield+shield+settled event history, not from on-chain state.
#
# Requires the pinned toolchain on PATH: nargo 1.0.0-beta.9, bb v0.87.0, and cargo (for the witness
# bin). See README.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIFT="$ROOT/circuits/lift"
UNSHIELD="$ROOT/circuits/unshield"
IDX="$ROOT/tools/indexer"
OUT="$ROOT/contracts/settlement/tests/fixtures/demo"
export PATH="$HOME/.nargo/bin:$HOME/.bb:$HOME/.cargo/bin:$PATH"
mkdir -p "$OUT"

# Restore the committed Prover.toml files on exit (this script overwrites them while proving).
cleanup() {
  git -C "$ROOT" checkout -- circuits/lift/Prover.toml circuits/unshield/Prover.toml 2>/dev/null || true
}
trap cleanup EXIT

# --- the path server / wallet helper ---------------------------------------------------------------
# w '<event log on stdin>' : run the witness bin, return its stdout.
w() { ( cd "$IDX" && cargo run -q --bin witness ); }
# field <cmd...> : run a single witness crypto command and capture its bare 0x.. result.
field() { printf '%s\n' "$*" | w; }

# --- scenario parameters ---------------------------------------------------------------------------
ASSET1=1; ASSET2=2
AMT_A=100; AMT_B=2000
MIN_A=1500   # A wants >= 1500 asset2 (receives 2000)
MIN_B=50     # B wants >= 50 asset1  (receives 100)
# Note keys (sk, rho) for the shielded input notes.
SKA=1111; RHOA=2222
SKB=3333; RHOB=4444
# Stealth keys for the proceeds notes each party will receive from the trade.
SKA2=5555; RHOA2=6666     # A's proceeds (2000 asset2)
SKB2=7777; RHOB2=8888     # B's proceeds (100 asset1)
CANCEL_A=9100; CANCEL_B=9200
# Order-book public inputs (lift fields [9]/[10]). The demo uses the atomic settle (full-fill), so
# partial execution is off; expiry is far in the future so the orders never look stale.
EXPIRY=9999999999; PARTIAL_A=0; PARTIAL_B=0
# The real address A withdraws its proceeds to.
DEMO_TO="CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"

echo ">>> computing field values via the path-server/wallet helper..."
OTA=$(field notetag $SKA $RHOA)            # owner_tag of shielded note A
OTB=$(field notetag $SKB $RHOB)            # owner_tag of shielded note B
OTA_OUT=$(field notetag $SKA2 $RHOA2)      # A's proceeds stealth tag
OTB_OUT=$(field notetag $SKB2 $RHOB2)      # B's proceeds stealth tag
NULL_A=$(field nullifier $SKA $RHOA)
NULL_B=$(field nullifier $SKB $RHOB)
NULL_AOUT=$(field nullifier $SKA2 $RHOA2)  # nullifier of A's proceeds note (for unshield)
OLEAF_A=$(field orderleaf $ASSET1 $AMT_A $ASSET2 $MIN_A "$OTA_OUT" $CANCEL_A $EXPIRY $PARTIAL_A)
OLEAF_B=$(field orderleaf $ASSET2 $AMT_B $ASSET1 $MIN_B "$OTB_OUT" $CANCEL_B $EXPIRY $PARTIAL_B)
RECIP=$(field recipient "$DEMO_TO")

# Persist the owner tags the contract's shield calls need (as raw 32-byte words for the test).
hex_to_bin() { printf '%s' "${1#0x}" | xxd -r -p; }
hex_to_bin "$OTA" > "$OUT/owner_tag_a"
hex_to_bin "$OTB" > "$OUT/owner_tag_b"

# --- derive membership witnesses from the event history -------------------------------------------
# Orders A and B prove membership against R2 (after the two shields).
WIT_AB=$(w <<EOF
shield $ASSET1 $AMT_A $OTA
shield $ASSET2 $AMT_B $OTB
path 0
path 1
EOF
)
# The unshield proves membership of leaf 2 (A's proceeds) against R4 (after settle inserts 2 leaves).
WIT_U=$(w <<EOF
shield $ASSET1 $AMT_A $OTA
shield $ASSET2 $AMT_B $OTB
settled $ASSET2 $AMT_B $OTA_OUT $ASSET1 $AMT_A $OTB_OUT
path 2
EOF
)

# Pull the `root`/`path`/`index_bits` Prover.toml lines for a given leaf index out of witness output.
# Each `path N` block is delimited by the "witness for leaf index N" comment.
witness_block() { # $1 = full witness output, $2 = leaf index
  awk -v idx="$2" '
    $0 ~ ("witness for leaf index " idx " ") {grab=1; next}
    grab && /^# --- Prover.toml witness/ {grab=0}
    grab && /^(root|path|index_bits) =/ {print}
  ' <<<"$1"
}

prove() { # $1=circuit dir, $2=pkg name, $3=out label
  cd "$1"
  nargo execute
  bb prove    -b "target/$2.json" -w "target/$2.gz" -o target \
    --scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields
  bb write_vk -b "target/$2.json" -o target \
    --scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields
  if [ -d target/vk ] && [ -f target/vk/vk ]; then
    mv target/vk/vk target/vk.tmp && rmdir target/vk && mv target/vk.tmp target/vk
  fi
  cp target/proof "$OUT/proof_$3"
  cp target/public_inputs "$OUT/public_inputs_$3"
  cp target/vk "$OUT/vk_$3"
}

# --- order A proof --------------------------------------------------------------------------------
echo ">>> proving order A..."
{
  echo "rho_in = \"$RHOA\""
  echo "sk_o = \"$SKA\""
  witness_block "$WIT_AB" 0
  echo "domain = \"1\""
  echo "nullifier_in = \"$NULL_A\""
  echo "asset_in = \"$ASSET1\""
  echo "amount_in = \"$AMT_A\""
  echo "asset_out = \"$ASSET2\""
  echo "min_out = \"$MIN_A\""
  echo "output_owner_tag = \"$OTA_OUT\""
  echo "cancel_owner_tag = \"$CANCEL_A\""
  echo "expiry = \"$EXPIRY\""
  echo "partial_allowed = \"$PARTIAL_A\""
  echo "order_leaf = \"$OLEAF_A\""
} > "$LIFT/Prover.toml"
prove "$LIFT" lift a

# --- order B proof --------------------------------------------------------------------------------
echo ">>> proving order B..."
{
  echo "rho_in = \"$RHOB\""
  echo "sk_o = \"$SKB\""
  witness_block "$WIT_AB" 1
  echo "domain = \"1\""
  echo "nullifier_in = \"$NULL_B\""
  echo "asset_in = \"$ASSET2\""
  echo "amount_in = \"$AMT_B\""
  echo "asset_out = \"$ASSET1\""
  echo "min_out = \"$MIN_B\""
  echo "output_owner_tag = \"$OTB_OUT\""
  echo "cancel_owner_tag = \"$CANCEL_B\""
  echo "expiry = \"$EXPIRY\""
  echo "partial_allowed = \"$PARTIAL_B\""
  echo "order_leaf = \"$OLEAF_B\""
} > "$LIFT/Prover.toml"
prove "$LIFT" lift b
cp "$LIFT/target/vk" "$OUT/vk"   # order/lift VK (same circuit for A and B)

# --- unshield A's proceeds note (leaf 2) ----------------------------------------------------------
echo ">>> proving unshield of A's settle-created proceeds note..."
{
  echo "rho_in = \"$RHOA2\""
  echo "sk_o = \"$SKA2\""
  witness_block "$WIT_U" 2
  echo "domain = \"2\""
  echo "nullifier = \"$NULL_AOUT\""
  echo "asset = \"$ASSET2\""
  echo "amount = \"$AMT_B\""
  echo "recipient = \"$RECIP\""
} > "$UNSHIELD/Prover.toml"
prove "$UNSHIELD" unshield u
mv "$OUT/vk_u" "$OUT/unshield_vk"
mv "$OUT/proof_u" "$OUT/unshield_proof"
mv "$OUT/public_inputs_u" "$OUT/unshield_public_inputs"
rm -f "$OUT/vk_a" "$OUT/vk_b"

echo
echo ">>> demo fixtures written to $OUT:"
ls -1 "$OUT"
echo ">>> now run: cd contracts/settlement && cargo test --test e2e_demo -- --nocapture"
