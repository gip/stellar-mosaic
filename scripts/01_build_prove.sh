#!/usr/bin/env bash
# Milestone 0 - LOCAL half: compile the circuit, prove, and verify accept + reject.
# Pinned toolchain (see CLAUDE.md / docs/implementation.md): nargo 1.0.0-beta.9, bb v0.87.0.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CIRCUIT="$ROOT/circuits/spend"
ART="$ROOT/artifacts"
SCHEME="ultra_honk"
mkdir -p "$ART"

echo "== compile =="
( cd "$CIRCUIT" && nargo compile )

echo "== circuit size (M0 metric) =="
bb gates -b "$CIRCUIT/target/spend.json"

echo "== execute (witness) =="
( cd "$CIRCUIT" && nargo execute )

echo "== prove =="
bb prove -b "$CIRCUIT/target/spend.json" -w "$CIRCUIT/target/spend.gz" -o "$ART" \
  --scheme "$SCHEME" --oracle_hash keccak --output_format bytes_and_fields

echo "== write_vk =="
bb write_vk -b "$CIRCUIT/target/spend.json" -o "$ART" \
  --scheme "$SCHEME" --oracle_hash keccak --output_format bytes_and_fields
if [ -d "$ART/vk" ] && [ -f "$ART/vk/vk" ]; then
  mv "$ART/vk/vk" "$ART/vk.tmp" && rmdir "$ART/vk" && mv "$ART/vk.tmp" "$ART/vk"
fi

echo "== verify VALID proof (must PASS) =="
bb verify -p "$ART/proof" -i "$ART/public_inputs" -k "$ART/vk" --scheme "$SCHEME" --oracle_hash keccak

echo "== verify CORRUPTED proof (must FAIL) =="
cp "$ART/proof" "$ART/proof.bad"
printf '\xff\xff\xff\xff' | dd of="$ART/proof.bad" bs=1 seek=5000 count=4 conv=notrunc 2>/dev/null
if bb verify -p "$ART/proof.bad" -i "$ART/public_inputs" -k "$ART/vk" --scheme "$SCHEME" --oracle_hash keccak 2>/dev/null; then
  echo "FAIL: corrupted proof verified - verifier is broken!"; exit 1
else
  echo "OK: corrupted proof correctly rejected"
fi

echo
echo "proof size:  $(wc -c < "$ART/proof") bytes"
echo "vk size:     $(wc -c < "$ART/vk") bytes"
echo "LOCAL MILESTONE 0 PASSED."
