#!/usr/bin/env bash
# Build the artifacts the web app needs and copy them into place:
#   - settlement.wasm  -> backend/artifacts/   (deploy input for new desks)
#   - lift/unshield/cancel/join + order_terms/note_tag/join_terms ACIR
#     -> frontend/public/circuits/
#     (in-browser execute + prove)
#
# VKs (backend/vks/{lift,unshield,cancel,join}_vk) are committed and already match these circuits
# (bb v0.87.0). Regenerate a circuit's VK after editing it, e.g. for join:
#   ( cd circuits/join && bb write_vk -b target/join.json -o target \
#       --scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields \
#     && cp target/vk ../../backend/vks/join_vk )
# Requires the pinned toolchain: nargo 1.0.0-beta.9, bb v0.87.0, stellar CLI.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo ">>> build settlement.wasm"
( cd "$ROOT/contracts/settlement" && stellar contract build >/dev/null )
mkdir -p "$ROOT/backend/artifacts"
cp "$ROOT/contracts/settlement/target/wasm32v1-none/release/settlement.wasm" \
   "$ROOT/backend/artifacts/settlement.wasm"

echo ">>> compile circuits + ship ACIR to the frontend"
mkdir -p "$ROOT/frontend/public/circuits"
for c in lift unshield cancel join; do
  ( cd "$ROOT/circuits/$c" && nargo compile >/dev/null )
  cp "$ROOT/circuits/$c/target/$c.json" "$ROOT/frontend/public/circuits/$c.json"
done
for c in note_tag order_terms join_terms; do
  ( cd "$ROOT/circuits/wallet/$c" && nargo compile >/dev/null )
  cp "$ROOT/circuits/wallet/$c/target/$c.json" "$ROOT/frontend/public/circuits/$c.json"
done

echo ">>> done. backend/artifacts + frontend/public/circuits are up to date."
