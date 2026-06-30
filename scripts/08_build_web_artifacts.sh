#!/usr/bin/env bash
# Build the artifacts the web app needs and copy them into place:
#   - settlement.wasm  -> backend/artifacts/, frontend/public/, packages/sdk/assets/
#     (deploy input for new desks, including browser trustless deployment)
#   - VKs              -> frontend/public/vks/, packages/sdk/assets/vks/
#   - lift/unshield/cancel/join + order_terms/note_tag/join_terms ACIR
#     -> frontend/public/circuits/
#   - Noir runtime WASM -> frontend/public/noir-wasm/
#   - canonical MosaicBridge ABI/bytecode -> backend/artifacts/MosaicBridge.json
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
# The portable @mosaic/sdk bundles the same artifacts so it is self-contained (browser + Node).
SDK_ASSETS="$ROOT/packages/sdk/assets"
mkdir -p "$SDK_ASSETS/circuits" "$SDK_ASSETS/vks"

echo ">>> build settlement.wasm"
( cd "$ROOT/contracts/settlement" && stellar contract build --optimize >/dev/null )
mkdir -p "$ROOT/backend/artifacts"
cp "$ROOT/contracts/settlement/target/wasm32v1-none/release/settlement.wasm" \
   "$ROOT/backend/artifacts/settlement.wasm"
cp "$ROOT/backend/artifacts/settlement.wasm" "$SDK_ASSETS/settlement.wasm"
cp "$ROOT/backend/artifacts/settlement.wasm" "$ROOT/frontend/public/settlement.wasm"

echo ">>> build MosaicBridge deployment artifact"
( cd "$ROOT/evm" && forge build >/dev/null )
cp "$ROOT/evm/out/MosaicBridge.sol/MosaicBridge.json" \
   "$ROOT/backend/artifacts/MosaicBridge.json"
cp "$ROOT/backend/artifacts/MosaicBridge.json" "$SDK_ASSETS/MosaicBridge.json"

echo ">>> ship verifying keys to the SDK bundle"
mkdir -p "$ROOT/frontend/public/vks"
cp "$ROOT/backend/vks/"{lift,unshield,cancel,join}_vk "$SDK_ASSETS/vks/"
cp "$ROOT/backend/vks/"{lift,unshield,cancel,join}_vk "$ROOT/frontend/public/vks/"

WASM_HASH=$(shasum -a 256 "$ROOT/backend/artifacts/settlement.wasm" | awk '{print $1}')
LIFT_HASH=$(shasum -a 256 "$ROOT/backend/vks/lift_vk" | awk '{print $1}')
UNSHIELD_HASH=$(shasum -a 256 "$ROOT/backend/vks/unshield_vk" | awk '{print $1}')
CANCEL_HASH=$(shasum -a 256 "$ROOT/backend/vks/cancel_vk" | awk '{print $1}')
JOIN_HASH=$(shasum -a 256 "$ROOT/backend/vks/join_vk" | awk '{print $1}')
node -e 'const fs=require("fs"); const [wasm,lift,unshield,cancel,join,...outs]=process.argv.slice(1); const json=JSON.stringify({schema_version:1,wasm_hash:wasm,vk_hashes:{lift,unshield,cancel,join}},null,2)+"\n"; for(const out of outs) fs.writeFileSync(out, json)' \
  "$WASM_HASH" "$LIFT_HASH" "$UNSHIELD_HASH" "$CANCEL_HASH" "$JOIN_HASH" \
  "$ROOT/frontend/public/protocol-release.json" "$SDK_ASSETS/protocol-release.json"

echo ">>> compile circuits + ship ACIR to the frontend + SDK bundle"
mkdir -p "$ROOT/frontend/public/circuits"
for c in lift unshield cancel join; do
  ( cd "$ROOT/circuits/$c" && nargo compile >/dev/null )
  cp "$ROOT/circuits/$c/target/$c.json" "$ROOT/frontend/public/circuits/$c.json"
  cp "$ROOT/circuits/$c/target/$c.json" "$SDK_ASSETS/circuits/$c.json"
done
# `compress` is the SDK-only primitive used to rebuild Merkle paths off-chain (not served to the
# frontend's prover, but bundled so @mosaic/sdk's LocalPathProvider works headlessly).
for c in note_tag order_terms join_terms compress; do
  ( cd "$ROOT/circuits/wallet/$c" && nargo compile >/dev/null )
  cp "$ROOT/circuits/wallet/$c/target/$c.json" "$ROOT/frontend/public/circuits/$c.json"
  cp "$ROOT/circuits/wallet/$c/target/$c.json" "$SDK_ASSETS/circuits/$c.json"
done

echo ">>> ship Noir runtime WASM to the frontend"
mkdir -p "$ROOT/frontend/public/noir-wasm"
cp "$ROOT/node_modules/.pnpm/@noir-lang+acvm_js@1.0.0-beta.9/node_modules/@noir-lang/acvm_js/web/acvm_js_bg.wasm" \
   "$ROOT/frontend/public/noir-wasm/acvm_js_bg.wasm"
cp "$ROOT/node_modules/.pnpm/@noir-lang+noirc_abi@1.0.0-beta.9/node_modules/@noir-lang/noirc_abi/web/noirc_abi_wasm_bg.wasm" \
   "$ROOT/frontend/public/noir-wasm/noirc_abi_wasm_bg.wasm"

echo ">>> done. backend/artifacts, frontend/public, and packages/sdk/assets are up to date."
