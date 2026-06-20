#!/usr/bin/env bash
# Generate the join test fixtures (contracts/settlement/tests/fixtures/join/): ONE real join proof
# that consolidates two same-asset notes (A=150 + B=200 of asset 1) into a target (300) + change (50),
# proven against the root the on-chain tree produces after the two shields. Consumed by
# `cargo test --test join`. Mirrors scripts/05_gen_book_fixtures.sh.
#
# Scenario (asset 1):
#   shield A=150 a1 (leaf 0), B=200 a1 (leaf 1) -> root R2
#   join: consume A + B  ->  out_1 = 300 a1 (target) + out_2 = 50 a1 (change)   (150+200 == 300+50)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JOIN="$ROOT/circuits/join"; IDX="$ROOT/tools/indexer"
OUT="$ROOT/contracts/settlement/tests/fixtures/join"
export PATH="$HOME/.nargo/bin:$HOME/.bb:$HOME/.cargo/bin:$PATH"
mkdir -p "$OUT"
trap 'git -C "$ROOT" checkout -- circuits/join/Prover.toml 2>/dev/null || true' EXIT

w() { ( cd "$IDX" && cargo run -q --bin witness ); }
field() { printf '%s\n' "$*" | w; }
hex_to_bin() { printf '%s' "${1#0x}" | xxd -r -p; }

# Extract a leaf's witness from the path-server output, renaming path/index_bits to the join
# circuit's per-input names (path_1/index_bits_1 for leaf 0, path_2/index_bits_2 for leaf 1).
witness_path() { # $1 WIT  $2 leaf_index  $3 suffix(1|2)
  awk -v idx="$2" -v sfx="$3" '
    $0 ~ ("witness for leaf index " idx " ") {grab=1; next}
    grab && /^# --- Prover.toml witness/ {grab=0}
    grab && /^path =/        {sub(/^path/, "path_" sfx); print}
    grab && /^index_bits =/  {sub(/^index_bits/, "index_bits_" sfx); print}
  ' <<<"$1"
}

A1=1
AMT_A=150; AMT_B=200; TARGET=300; CHANGE=50
# input-note keys (per-note sk, matching the wallet's key model)
SK1=4001; RHO1=5001; SK2=4002; RHO2=5002
# output-note keys (fresh per output note)
SKO1=4101; RHOO1=5101; SKO2=4102; RHOO2=5102

echo ">>> field values"
OT_A=$(field notetag $SK1 $RHO1)
OT_B=$(field notetag $SK2 $RHO2)
NF1=$(field nullifier $SK1 $RHO1)
NF2=$(field nullifier $SK2 $RHO2)
OUT_TAG1=$(field notetag $SKO1 $RHOO1)
OUT_TAG2=$(field notetag $SKO2 $RHOO2)

WIT=$(w <<EOF
shield $A1 $AMT_A $OT_A
shield $A1 $AMT_B $OT_B
path 0
path 1
EOF
)
ROOT_LINE=$(awk '/^root =/{print; exit}' <<<"$WIT")

hex_to_bin "$OT_A" > "$OUT/owner_tag_a"
hex_to_bin "$OT_B" > "$OUT/owner_tag_b"

{
  echo "sk_1 = \"$SK1\""; echo "rho_1 = \"$RHO1\""; echo "amount_1 = \"$AMT_A\""
  witness_path "$WIT" 0 1
  echo "sk_2 = \"$SK2\""; echo "rho_2 = \"$RHO2\""; echo "amount_2 = \"$AMT_B\""
  witness_path "$WIT" 1 2
  echo "domain = \"4\""
  echo "$ROOT_LINE"
  echo "nullifier_1 = \"$NF1\""; echo "nullifier_2 = \"$NF2\""
  echo "asset = \"$A1\""
  echo "out_tag_1 = \"$OUT_TAG1\""; echo "out_amount_1 = \"$TARGET\""
  echo "out_tag_2 = \"$OUT_TAG2\""; echo "out_amount_2 = \"$CHANGE\""
} > "$JOIN/Prover.toml"

echo ">>> proving join"
cd "$JOIN"; nargo execute >/dev/null
bb prove    -b target/join.json -w target/join.gz -o target --scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields >/dev/null 2>&1
bb write_vk -b target/join.json -o target --scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields >/dev/null 2>&1
if [ -d target/vk ] && [ -f target/vk/vk ]; then mv target/vk/vk target/vk.tmp && rmdir target/vk && mv target/vk.tmp target/vk; fi
cp target/proof "$OUT/join_proof"; cp target/public_inputs "$OUT/join_public_inputs"; cp target/vk "$OUT/join_vk"

echo ">>> join fixtures written:"; ls -1 "$OUT"
