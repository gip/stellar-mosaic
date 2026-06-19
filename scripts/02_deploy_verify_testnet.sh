#!/usr/bin/env bash
# Legacy Milestone 0 on-chain half: verify our spend proof on Stellar testnet using the
# indextree UltraHonk Soroban verifier. Current architecture and Nethermind-based
# measurements are summarized in docs/architecture.md and docs/milestone-0-results.md.
#
# WARNING: step 0 changes your GLOBAL nargo/bb (installed under ~/.nargo and ~/.bb)
# to the versions the verifier requires. Your system currently has the wrong ones.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CIRCUIT="$ROOT/circuits/spend"
VENDOR="$ROOT/vendor/ultrahonk_soroban_contract"
NETWORK="${NETWORK:-testnet}"
IDENTITY="${IDENTITY:-m0}"
NOIR_VERSION="1.0.0-beta.9"   # pinned by vendor/tests/build_circuits.sh
BB_VERSION="v0.87.0"          # bb proof format differs from our installed 0.82.2

# ---- 0. PIN TOOLCHAIN (the #1 footgun: system nargo/bb are the WRONG versions) ----
export PATH="$HOME/.nargo/bin:$HOME/.bb/bin:$PATH"
echo "== pinning nargo $NOIR_VERSION =="
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
noirup -v "$NOIR_VERSION"
echo "== pinning bb $BB_VERSION =="
mkdir -p "$HOME/.bb/bin"
case "$(uname -s)_$(uname -m)" in
  Darwin_arm64)  BBFILE="barretenberg-arm64-darwin.tar.gz" ;;
  Darwin_x86_64) BBFILE="barretenberg-amd64-darwin.tar.gz" ;;
  Linux_x86_64)  BBFILE="barretenberg-amd64-linux.tar.gz" ;;
  *) echo "unsupported platform"; exit 1 ;;
esac
curl -L "https://github.com/AztecProtocol/aztec-packages/releases/download/${BB_VERSION}/${BBFILE}" -o /tmp/bb.tar.gz
tar -xzf /tmp/bb.tar.gz -C "$HOME/.bb/bin" && chmod +x "$HOME/.bb/bin/bb"
echo "now using: nargo=$(nargo --version | head -1) | bb=$(bb --version)"

# ---- 1. build OUR circuit's artifacts with the EXACT flags the contract expects ----
cd "$CIRCUIT"
nargo compile     # if the poseidon2 import path changed in beta.9, fix it here
nargo execute
bb prove    -b target/spend.json -w target/spend.gz -o target \
  --scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields
bb write_vk -b target/spend.json -o target \
  --scheme ultra_honk --oracle_hash keccak --output_format bytes_and_fields
# write_vk may emit target/vk/vk (a dir) - normalize to a file at target/vk
if [ -d target/vk ] && [ -f target/vk/vk ]; then
  mv target/vk/vk target/vk.tmp && rmdir target/vk && mv target/vk.tmp target/vk
fi
ls -la target/proof target/public_inputs target/vk

# ---- 2. testnet identity (friendbot-funded) ----
stellar keys address "$IDENTITY" --network "$NETWORK" 2>/dev/null \
  || { stellar keys generate "$IDENTITY" --network "$NETWORK"; stellar keys fund "$IDENTITY" --network "$NETWORK"; }

# ---- 3. build + deploy the verifier, setting OUR vk at construction ----
cd "$VENDOR"
rustup target add wasm32v1-none
stellar contract build --optimize
CID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/ultrahonk_soroban_contract.wasm \
  --source "$IDENTITY" --network "$NETWORK" \
  -- --vk_bytes-file-path "$CIRCUIT/target/vk")
echo "VERIFIER CONTRACT: $CID"

# ---- 4. invoke verify_proof on-chain, capturing resource cost ----
echo "== verify VALID proof on testnet (must succeed) =="
stellar contract invoke --id "$CID" --source "$IDENTITY" --network "$NETWORK" --send yes --cost \
  -- verify_proof \
  --public_inputs-file-path "$CIRCUIT/target/public_inputs" \
  --proof_bytes-file-path "$CIRCUIT/target/proof"

echo "== verify CORRUPTED proof on testnet (must fail) =="
cp "$CIRCUIT/target/proof" "$CIRCUIT/target/proof.bad"
printf '\xff\xff\xff\xff' | dd of="$CIRCUIT/target/proof.bad" bs=1 seek=5000 count=4 conv=notrunc 2>/dev/null
if stellar contract invoke --id "$CID" --source "$IDENTITY" --network "$NETWORK" --send yes --cost \
  -- verify_proof \
  --public_inputs-file-path "$CIRCUIT/target/public_inputs" \
  --proof_bytes-file-path "$CIRCUIT/target/proof.bad" 2>/dev/null; then
  echo "FAIL: corrupted proof accepted on-chain!"
else
  echo "OK: corrupted proof rejected on-chain"
fi

echo
echo ">>> If these metrics change, update docs/milestone-0-results.md."
echo ">>> Current architecture: atomic settle verifies BOTH order proofs in one tx (~160M = ~40% of"
echo ">>> the 400M per-tx budget). See docs/architecture.md + docs/tx-instruction-limit-spike.md."
