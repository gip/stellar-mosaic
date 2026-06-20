#!/usr/bin/env bash
# Generate ABSOLUTE-WORST-CASE order-book fixtures: 64 resting SELL makers + 1 BUY taker, all proven
# against the root after 65 shields. The taker crosses the full 64-deep book and fills the 4-fill cap
# (MAX_FILLS_PER_SUBMIT), so its submit_order is the most expensive book transaction possible:
# verify + load 64 + 8 proceeds inserts + store ~60 + rest. Output: fixtures/book_worst/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIFT="$ROOT/circuits/lift"; IDX="$ROOT/tools/indexer"
OUT="$ROOT/contracts/settlement/tests/fixtures/book_worst"
export PATH="$HOME/.nargo/bin:$HOME/.bb:$HOME/.cargo/bin:$PATH"
mkdir -p "$OUT"
trap 'git -C "$ROOT" checkout -- circuits/lift/Prover.toml 2>/dev/null || true' EXIT

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

A1=1; A2=2; FAR=9999999999; N=64

echo ">>> deriving owner tags + building the 65-leaf shield history"
SHIELDS=""
for i in $(seq 0 $((N-1))); do
  ot=$(field notetag $((10000+i)) $((20000+i)))
  echo "$ot" >> "$OUT/.maker_tags"
  hex_to_bin "$ot" > "$OUT/owner_tag_m$i"
  SHIELDS+="shield $A1 10 $ot"$'\n'
done
OT_T=$(field notetag 30001 40001); hex_to_bin "$OT_T" > "$OUT/owner_tag_t"
SHIELDS+="shield $A2 2400 $OT_T"$'\n'
PATHS=""; for i in $(seq 0 $N); do PATHS+="path $i"$'\n'; done
WIT=$(printf '%s%s' "$SHIELDS" "$PATHS" | w)
rm -f "$OUT/.maker_tags"

echo ">>> proving 64 maker sells (10 a1 @150, price 15) — this takes a few minutes"
for i in $(seq 0 $((N-1))); do
  nf=$(field nullifier $((10000+i)) $((20000+i)))
  ol=$(field orderleaf $A1 10 $A2 150 $((70000+i)) $((80000+i)) $FAR 1)
  { echo "rho_in = \"$((20000+i))\""; echo "sk_o = \"$((10000+i))\""; witness_block "$WIT" "$i"
    echo "domain = \"1\""; echo "nullifier_in = \"$nf\""; echo "asset_in = \"$A1\""
    echo "amount_in = \"10\""; echo "asset_out = \"$A2\""; echo "min_out = \"150\""
    echo "output_owner_tag = \"$((70000+i))\""; echo "cancel_owner_tag = \"$((80000+i))\""
    echo "expiry = \"$FAR\""; echo "partial_allowed = \"1\""; echo "order_leaf = \"$ol\""
  } > "$LIFT/Prover.toml"
  prove_lift "m$i"
  [ $((i % 8)) -eq 0 ] && echo "    ...maker $i proved"
done

echo ">>> proving the taker buy (offer 2400 a2, want 100 a1, price 24)"
nf=$(field nullifier 30001 40001)
ol=$(field orderleaf $A2 2400 $A1 100 99001 99002 $FAR 1)
{ echo "rho_in = \"40001\""; echo "sk_o = \"30001\""; witness_block "$WIT" "$N"
  echo "domain = \"1\""; echo "nullifier_in = \"$nf\""; echo "asset_in = \"$A2\""
  echo "amount_in = \"2400\""; echo "asset_out = \"$A1\""; echo "min_out = \"100\""
  echo "output_owner_tag = \"99001\""; echo "cancel_owner_tag = \"99002\""
  echo "expiry = \"$FAR\""; echo "partial_allowed = \"1\""; echo "order_leaf = \"$ol\""
} > "$LIFT/Prover.toml"
prove_lift t
cp "$LIFT/target/vk" "$OUT/vk"

echo ">>> done. $(ls "$OUT" | grep -c '^proof_') proofs + vk in $OUT"
