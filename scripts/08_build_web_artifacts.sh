#!/usr/bin/env bash
# Build the artifacts the web app needs and copy them into place:
#   - settlement.wasm  -> backend/artifacts/   (deploy input for new desks)
#   - lift/order_terms/note_tag ACIR -> frontend/public/circuits/  (in-browser execute + prove)
#
# VKs (backend/vks/) are committed and already match these circuits (bb v0.87.0). Requires the
# pinned toolchain: nargo 1.0.0-beta.9, bb v0.87.0, stellar CLI.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo ">>> build settlement.wasm"
( cd "$ROOT/contracts/settlement" && stellar contract build >/dev/null )
mkdir -p "$ROOT/backend/artifacts"
cp "$ROOT/contracts/settlement/target/wasm32v1-none/release/settlement.wasm" \
   "$ROOT/backend/artifacts/settlement.wasm"

echo ">>> compile circuits + ship ACIR to the frontend"
mkdir -p "$ROOT/frontend/public/circuits"
( cd "$ROOT/circuits/lift" && nargo compile >/dev/null )
cp "$ROOT/circuits/lift/target/lift.json" "$ROOT/frontend/public/circuits/lift.json"
for c in note_tag order_terms; do
  ( cd "$ROOT/circuits/wallet/$c" && nargo compile >/dev/null )
  cp "$ROOT/circuits/wallet/$c/target/$c.json" "$ROOT/frontend/public/circuits/$c.json"
done

echo ">>> done. backend/artifacts + frontend/public/circuits are up to date."
