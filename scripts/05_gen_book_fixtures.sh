#!/usr/bin/env bash
# Generate the order-book test fixtures (contracts/settlement/tests/fixtures/book/): four lift order
# proofs (S1/S2/S3 sells + B1 buy) all proven against the root after four shields, plus a cancel
# proof for S2. Consumed by `cargo test --test book`. See docs/simple-order-book.md for the scenario.
#
# Scenario (pair: base = asset 1, quote = asset 2):
#   shield notes: S1=100 a1 (leaf0), S2=100 a1 (leaf1), B1=2400 a2 (leaf2), S3=50 a1 (leaf3) -> R4
#   S1 SELL 100 a1 @ want 1500 a2 (price 15)   partial   expiry FAR
#   S2 SELL 100 a1 @ want 1600 a2 (price 16)   partial   expiry FAR   (cancel tag is a REAL tag)
#   S3 SELL 50  a1 @ want 1000 a2 (price 20)   partial   expiry 5000  (for the prune test)
#   B1 BUY  offer 2400 a2 want 100 a1 (price 24) partial expiry FAR
# B1 crosses S1 (fully) then S2 (partial 56), then rests with 4 a2; S3 never reached.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIFT="$ROOT/circuits/lift"; CANCEL="$ROOT/circuits/cancel"; IDX="$ROOT/tools/indexer"
OUT="$ROOT/contracts/settlement/tests/fixtures/book"
export PATH="$HOME/.nargo/bin:$HOME/.bb:$HOME/.cargo/bin:$PATH"
mkdir -p "$OUT"
trap 'git -C "$ROOT" checkout -- circuits/lift/Prover.toml circuits/cancel/Prover.toml 2>/dev/null || true' EXIT

w() { ( cd "$IDX" && cargo run -q --bin witness ); }
field() { printf '%s\n' "$*" | w; }
hex_to_bin() { printf '%s' "${1#0x}" | xxd -r -p; }
witness_block() {
  awk -v idx="$2" '
    $0 ~ ("witness for leaf index " idx " ") {grab=1; next}
    grab && /^# --- Prover.toml witness/ {grab=0}
    grab && /^(root|path|index_bits) =/ {print}
  ' <<<"$1"
}
prove_lift() { cd "$LIFT"; nargo execute >/dev/null
  bb prove -b target/lift.json -w target/lift.gz -o target --scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields >/dev/null 2>&1
  cp target/proof "$OUT/proof_$1"; cp target/public_inputs "$OUT/public_inputs_$1"; }

A1=1; A2=2; FAR=9999999999; S3_EXP=5000
# input-note keys
SKS1=7001; RHS1=8001; SKS2=7003; RHS2=8003; SKB1=7005; RHB1=8005; SKS3=7007; RHS3=8007
# S2 cancel-authority keys (must be a real tag so the cancel circuit can prove it)
SKC2=7103; RHC2=8103
# output / cancel tags (literals where we never cancel/spend them)
OS1=9001; CS1=9002; OS2=9006; OB1=9011; CB1=9012; OS3=9007; CS3=9008; RET=9300

echo ">>> field values"
OT_S1=$(field notetag $SKS1 $RHS1); OT_S2=$(field notetag $SKS2 $RHS2)
OT_B1=$(field notetag $SKB1 $RHB1); OT_S3=$(field notetag $SKS3 $RHS3)
CT_S2=$(field notetag $SKC2 $RHC2)               # real cancel tag for S2
NF_S1=$(field nullifier $SKS1 $RHS1); NF_S2=$(field nullifier $SKS2 $RHS2)
NF_B1=$(field nullifier $SKB1 $RHB1); NF_S3=$(field nullifier $SKS3 $RHS3)
OL_S1=$(field orderleaf $A1 100 $A2 1500 $OS1 $CS1 $FAR 1)
OL_S2=$(field orderleaf $A1 100 $A2 1600 $OS2 "$CT_S2" $FAR 1)
OL_B1=$(field orderleaf $A2 2400 $A1 100 $OB1 $CB1 $FAR 1)
OL_S3=$(field orderleaf $A1 50  $A2 1000 $OS3 $CS3 $S3_EXP 1)

WIT=$(w <<EOF
shield $A1 100 $OT_S1
shield $A1 100 $OT_S2
shield $A2 2400 $OT_B1
shield $A1 50 $OT_S3
path 0
path 1
path 2
path 3
EOF
)
for v in OT_S1 OT_S2 OT_B1 OT_S3; do :; done
hex_to_bin "$OT_S1" > "$OUT/owner_tag_s1"; hex_to_bin "$OT_S2" > "$OUT/owner_tag_s2"
hex_to_bin "$OT_B1" > "$OUT/owner_tag_b1"; hex_to_bin "$OT_S3" > "$OUT/owner_tag_s3"

emit_lift() { # $1 rho $2 sk $3 leaf $4 null $5 asset_in $6 amt $7 asset_out $8 min $9 outtag $10 canceltag $11 expiry $12 oleaf
  { echo "rho_in = \"$1\""; echo "sk_o = \"$2\""; witness_block "$WIT" "$3"; echo "domain = \"1\""
    echo "nullifier_in = \"$4\""; echo "asset_in = \"$5\""; echo "amount_in = \"$6\""
    echo "asset_out = \"$7\""; echo "min_out = \"$8\""; echo "output_owner_tag = \"$9\""
    echo "cancel_owner_tag = \"${10}\""; echo "expiry = \"${11}\""; echo "partial_allowed = \"1\""
    echo "order_leaf = \"${12}\""; } > "$LIFT/Prover.toml"
}

echo ">>> proving S1, S2, S3, B1"
emit_lift $RHS1 $SKS1 0 "$NF_S1" $A1 100  $A2 1500 $OS1 $CS1   $FAR    "$OL_S1"; prove_lift s1
emit_lift $RHS2 $SKS2 1 "$NF_S2" $A1 100  $A2 1600 $OS2 "$CT_S2" $FAR   "$OL_S2"; prove_lift s2
emit_lift $RHB1 $SKB1 2 "$NF_B1" $A2 2400 $A1 100  $OB1 $CB1   $FAR    "$OL_B1"; prove_lift b1
emit_lift $RHS3 $SKS3 3 "$NF_S3" $A1 50   $A2 1000 $OS3 $CS3   $S3_EXP "$OL_S3"; prove_lift s3
( cd "$LIFT" && bb write_vk -b target/lift.json -o target --scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields >/dev/null 2>&1
  if [ -d target/vk ] && [ -f target/vk/vk ]; then mv target/vk/vk target/vk.tmp && rmdir target/vk && mv target/vk.tmp target/vk; fi )
cp "$LIFT/target/vk" "$OUT/vk"   # lift VK (same circuit as the integration vk)

echo ">>> proving cancel(S2)"
{ echo "sk_o = \"$SKC2\""; echo "rho_ord = \"$RHC2\""; echo "domain = \"3\""
  echo "order_leaf = \"$OL_S2\""; echo "cancel_owner_tag = \"$CT_S2\""; echo "return_owner_tag = \"$RET\""
} > "$CANCEL/Prover.toml"
cd "$CANCEL"; nargo execute >/dev/null
bb prove    -b target/cancel.json -w target/cancel.gz -o target --scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields >/dev/null 2>&1
bb write_vk -b target/cancel.json -o target --scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields >/dev/null 2>&1
if [ -d target/vk ] && [ -f target/vk/vk ]; then mv target/vk/vk target/vk.tmp && rmdir target/vk && mv target/vk.tmp target/vk; fi
cp target/proof "$OUT/cancel_proof"; cp target/public_inputs "$OUT/cancel_public_inputs"; cp target/vk "$OUT/cancel_vk"

echo ">>> book fixtures written:"; ls -1 "$OUT"
