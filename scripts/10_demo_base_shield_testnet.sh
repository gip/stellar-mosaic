#!/usr/bin/env bash
# End-to-end demo: shield USDC on BASE SEPOLIA and mint the matching note on STELLAR TESTNET, via a
# real RISC Zero / Steel Groth16 proof verified on Soroban. WS8 orchestration of the Base-shield
# bridge (docs/base-bridge.md): Base deposit -> prove from state -> attest block -> shield_from_base.
#
# Reproduces the validated manual run. Self-contained on the Base side (deploys a MockUSDC and mints,
# so no faucet); reuses an already-deployed verifier router on Stellar.
#
#   PREREQUISITES:
#     - foundry (forge, cast) + a funded BASE SEPOLIA key:   export PRIVATE_KEY=0x...
#     - a Base Sepolia RPC that serves eth_getProof:          export BASE_RPC=...   (Alchemy etc.)
#     - the RISC Zero Groth16 prover stack (Docker for the wrap), e.g. export RISC0_PROVER=local
#     - stellar CLI + a funded testnet identity (default IDENTITY=m0; auto-funded via friendbot)
#     - the Nethermind verifier ROUTER deployed on Stellar testnet, in ROUTER_ID. Deploy once from
#       vendor/stellar-risc0-verifier and register our seal selector 73c457ba:
#         ./scripts/manage.sh deploy-router         -n testnet -a <acct> --min-delay 0
#         ./scripts/manage.sh deploy-verifier       -n testnet -a <acct>
#         ./scripts/manage.sh schedule-add-verifier -n testnet -a <acct> --selector 73c457ba
#         ./scripts/manage.sh execute-add-verifier  -n testnet -a <acct> --selector 73c457ba
#
# By default the proof anchors to the latest FINALIZED Base block (reorg-safe), which means waiting
# for the deposit to finalize (~10-15 min on Base Sepolia). Set UNSAFE_FAST=1 to instead prove
# immediately against the deposit's own (non-finalized) block — quick, but reorg-risky; demo only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVM="$ROOT/evm"
PROVER="$ROOT/bridge-prover"
CONTRACT="$ROOT/contracts/settlement"
FIX="$CONTRACT/tests/fixtures"
export PATH="$HOME/.cargo/bin:$HOME/.foundry/bin:$PATH"

# --- config (override via env) ---
BASE_RPC="${BASE_RPC:-https://sepolia.base.org}"
NETWORK="${NETWORK:-testnet}"
IDENTITY="${IDENTITY:-m0}"
ASSET_ID="${ASSET_ID:-1}"
AMOUNT="${AMOUNT:-1000000}"                  # 1 USDC (6 dp)
DEPOSIT_ID="${DEPOSIT_ID:-0}"                # fresh bridge -> first deposit is 0
# owner_tag: an opaque BN254 Fr element (< the scalar field modulus r). Any small constant works for
# the demo; a real wallet uses Poseidon(pk_o, rho). NOTE: must be < r (0x11.. ok; 0x33.. is NOT).
OWNER_TAG="${OWNER_TAG:-0x1111111111111111111111111111111111111111111111111111111111111111}"
# Pinned guest image id + Base Sepolia config digest (regenerate via bridge-prover print_journal_fixture).
IMAGE_ID="${IMAGE_ID:-333e192f991c82a12d4fbf779342c918af4eca4d8eba66908f2ac020c46d26a5}"
CONFIG_ID="${CONFIG_ID:-3519660d6ecbd34367740f5ca18449cba8b389594f69f177bbf21c46e505c61e}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: '$1' not found on PATH"; exit 1; }; }
need forge; need cast; need stellar; need jq; need xxd
: "${PRIVATE_KEY:?set PRIVATE_KEY to a funded Base Sepolia key}"
: "${ROUTER_ID:?set ROUTER_ID to the deployed Stellar RISC Zero verifier router (see header)}"

casts() { cast send --rpc-url "$BASE_RPC" --private-key "$PRIVATE_KEY" "$@"; }

echo "==> 0. context"
ADMIN_EVM=$(cast wallet address --private-key "$PRIVATE_KEY")
echo "    base deployer = $ADMIN_EVM   rpc = $BASE_RPC"
STELLAR_ADDR=$(stellar keys address "$IDENTITY" 2>/dev/null) \
  || { stellar keys generate "$IDENTITY" --network "$NETWORK"; stellar keys fund "$IDENTITY" --network "$NETWORK"; STELLAR_ADDR=$(stellar keys address "$IDENTITY"); }
XLM_SAC=$(stellar contract id asset --asset native --network "$NETWORK")
echo "    stellar admin = $STELLAR_ADDR   router = $ROUTER_ID"

# Manage nonces explicitly: public RPCs lag on pending-nonce, which makes rapid back-to-back txs
# collide ("replacement transaction underpriced"). We assign sequential nonces ourselves.
NONCE=$(cast nonce "$ADMIN_EVM" --rpc-url "$BASE_RPC")
echo "==> 1. deploy MockUSDC + MosaicBridge on Base Sepolia, register + mint (nonce base $NONCE)"
USDC=$(cd "$EVM" && forge create test/mocks/MockUSDC.sol:MockUSDC \
  --rpc-url "$BASE_RPC" --private-key "$PRIVATE_KEY" --broadcast --json --nonce "$NONCE" | jq -r .deployedTo); NONCE=$((NONCE+1))
BRIDGE=$(cd "$EVM" && forge create src/MosaicBridge.sol:MosaicBridge \
  --rpc-url "$BASE_RPC" --private-key "$PRIVATE_KEY" --broadcast --json \
  --nonce "$NONCE" --constructor-args "$ADMIN_EVM" | jq -r .deployedTo); NONCE=$((NONCE+1))   # --constructor-args last
echo "    usdc = $USDC   bridge = $BRIDGE"
casts --nonce "$NONCE" "$USDC" 'mint(address,uint256)' "$ADMIN_EVM" "$AMOUNT" >/dev/null; NONCE=$((NONCE+1))
casts --nonce "$NONCE" "$BRIDGE" 'registerAsset(uint32,address)' "$ASSET_ID" "$USDC" >/dev/null; NONCE=$((NONCE+1))

echo "==> 2. approve + shield $AMOUNT of asset $ASSET_ID"
casts --nonce "$NONCE" "$USDC" 'approve(address,uint256)' "$BRIDGE" "$AMOUNT" >/dev/null; NONCE=$((NONCE+1))
TXH=$(casts --nonce "$NONCE" "$BRIDGE" 'shield(uint32,uint256,bytes32)' "$ASSET_ID" "$AMOUNT" "$OWNER_TAG" --json | jq -r .transactionHash); NONCE=$((NONCE+1))
DEPOSIT_BLOCK=$(cast receipt "$TXH" blockNumber --rpc-url "$BASE_RPC")
echo "    shield tx = $TXH   deposit block = $DEPOSIT_BLOCK"

echo "==> 3. prove the deposit (Groth16) -> seal + journal"
if [ "${UNSAFE_FAST:-0}" = "1" ]; then
  echo "    UNSAFE_FAST=1: proving at the deposit's non-finalized block $DEPOSIT_BLOCK (reorg-risk)"
  BLOCK_OPT="--block $DEPOSIT_BLOCK"
else
  echo "    waiting for Base finality to reach block $DEPOSIT_BLOCK (~10-15 min)..."
  while :; do
    FIN=$(cast block finalized --field number --rpc-url "$BASE_RPC" 2>/dev/null || echo 0)
    [ -n "$FIN" ] && [ "$FIN" -ge "$DEPOSIT_BLOCK" ] && break
    echo "      finalized=$FIN target=$DEPOSIT_BLOCK; sleeping 30s"
    sleep 30
  done
  BLOCK_OPT=""   # host default = latest finalized block
fi
# $BLOCK_OPT is intentionally unquoted so it word-splits to "--block N" or to nothing (a plain
# string avoids the macOS bash 3.2 "unbound variable" trap on empty "${array[@]}" under set -u).
( cd "$PROVER" && RUST_LOG=info cargo run --release -p host -- \
    --rpc-url "$BASE_RPC" --bridge "$BRIDGE" --deposit-id "$DEPOSIT_ID" $BLOCK_OPT \
    --prove --out-dir "$PROVER/out" )
SEAL="$PROVER/out/seal.bin"; JOURNAL="$PROVER/out/journal.bin"
[ -s "$SEAL" ] && [ -s "$JOURNAL" ] || { echo "ERROR: proving did not emit seal/journal"; exit 1; }
# Journal word 0 = commitment.id (block number in the low 8 bytes); word 1 = block hash.
# `-c` keeps each value on ONE line (xxd -p wraps at 60 hex cols by default, which corrupts a 64-hex
# block hash with an embedded newline).
BLOCK=$(( 16#$(xxd -p -c 8 -s 24 -l 8 "$JOURNAL") ))
BLOCK_HASH=$(xxd -p -c 32 -s 32 -l 32 "$JOURNAL")
echo "    proof committed to block $BLOCK ($BLOCK_HASH)"

echo "==> 4. deploy + configure settlement on Stellar testnet"
( cd "$CONTRACT" && stellar contract build >/dev/null )
WASM="$CONTRACT/target/wasm32v1-none/release/settlement.wasm"
# Retry transient public-RPC failures (e.g. 502 gateway errors) up to 5x. Retry notices go to stderr
# so they don't pollute values captured via $(inv -- ...).
inv() {
  local i
  for i in 1 2 3 4 5; do
    stellar contract invoke --id "$CID" --source "$IDENTITY" --network "$NETWORK" "$@" && return 0
    echo "    (stellar invoke failed; retry $i/5 in 5s)" >&2; sleep 5
  done
  return 1
}
CID=$(stellar contract deploy --wasm "$WASM" --source "$IDENTITY" --network "$NETWORK" \
  -- --vk_bytes-file-path "$FIX/vk" --admin "$STELLAR_ADDR")
echo "    settlement = $CID"
inv --send yes -- register_asset --asset_id "$ASSET_ID" --token "$XLM_SAC" >/dev/null
inv --send yes -- configure_base_bridge \
  --router "$ROUTER_ID" --image_id "$IMAGE_ID" --config_id "$CONFIG_ID" --bridge "${BRIDGE#0x}" >/dev/null
# The trust anchor: the relayer attests the Base block hash (the one the proof committed to).
inv --send yes -- attest_base_block --block_number "$BLOCK" --block_hash "$BLOCK_HASH" >/dev/null

echo "==> 5. shield_from_base: verify the proof on-chain and mint the note"
ROOT_BEFORE=$(inv -- root 2>/dev/null | tr -d '"')
inv --send yes -- shield_from_base --seal-file-path "$SEAL" --journal-file-path "$JOURNAL" >/dev/null
ROOT_AFTER=$(inv -- root 2>/dev/null | tr -d '"')

echo "==> done"
echo "    settlement = $CID"
echo "    root before = $ROOT_BEFORE"
echo "    root after   = $ROOT_AFTER"
[ "$ROOT_BEFORE" != "$ROOT_AFTER" ] \
  && echo "    OK: tree root advanced — the Base deposit is now an active note on Stellar." \
  || { echo "    FAIL: root did not advance"; exit 1; }
