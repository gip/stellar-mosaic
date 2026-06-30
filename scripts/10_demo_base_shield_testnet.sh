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
# FINALITY TOGGLE. By DEFAULT this runs in FAST mode: it mints as soon as the proof is generated,
# against the proven (recent, not-yet-finalized) Base block — quick, but reorg-risky, so demo only.
# Set WAIT_FINALITY=1 for the reorg-safe path: hold the proof and wait for its block to finalize on
# Base (~10-15 min; a pure block-number check, no archive getProof) before minting.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVM="$ROOT/evm"
PROVER="$ROOT/bridge-prover"
CONTRACT="$ROOT/contracts/settlement"
FIX="$CONTRACT/tests/fixtures"
VKS="$ROOT/backend/vks"
export PATH="$HOME/.cargo/bin:$HOME/.foundry/bin:$PATH"

# Persist key outputs (Base contracts, settlement id, router, roots) to <repo>/.e2e/state.env so the
# e2e driver (scripts/e2e.sh) can report what was generated. Harmless on a direct run.
source "$ROOT/scripts/lib/e2e_state.sh"
source "$ROOT/scripts/lib/bridge_image_id.sh"

# --- config (override via env) ---
# BASE_RPC has no default ON PURPOSE: it must be an eth_getProof-capable endpoint (Alchemy/Infura).
# The public https://sepolia.base.org does NOT serve eth_getProof, so the prove step would fail.
BASE_RPC="${BASE_RPC:-}"
NETWORK="${NETWORK:-testnet}"
IDENTITY="${IDENTITY:-m0}"
ASSET_ID="${ASSET_ID:-1}"
AMOUNT="${AMOUNT:-1000000}"                  # 1 USDC (6 dp)
DEPOSIT_ID="${DEPOSIT_ID:-0}"                # fresh bridge -> first deposit is 0
# owner_tag: an opaque BN254 Fr element (< the scalar field modulus r). Any small constant works for
# the demo; a real wallet uses Poseidon(pk_o, rho). NOTE: must be < r (0x11.. ok; 0x33.. is NOT).
OWNER_TAG="${OWNER_TAG:-0x1111111111111111111111111111111111111111111111111111111111111111}"
# The reviewed guest image-ID pin is committed separately so builds, scripts, and docs share one
# source of truth. IMAGE_ID remains overridable for an intentional rotation, but it must still match
# the host binary that will produce the proof.
IMAGE_ID_PIN="$PROVER/image-id.hex"
IMAGE_ID="${IMAGE_ID:-$(bridge_image_id_read_pin "$IMAGE_ID_PIN")}"
CONFIG_ID="${CONFIG_ID:-3519660d6ecbd34367740f5ca18449cba8b389594f69f177bbf21c46e505c61e}"
# Some Base Sepolia RPC providers reject rapid delegated-account broadcasts even when explicit
# nonces are correct. Retry the exact same transaction nonce on that provider-side throttle.
BASE_TX_MAX_ATTEMPTS="${BASE_TX_MAX_ATTEMPTS:-8}"
BASE_TX_RETRY_DELAY="${BASE_TX_RETRY_DELAY:-15}"
BASE_TX_SETTLE_DELAY="${BASE_TX_SETTLE_DELAY:-3}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: '$1' not found on PATH"; exit 1; }; }
need forge; need cast; need stellar; need jq; need xxd
: "${PRIVATE_KEY:?set PRIVATE_KEY to a funded Base Sepolia key}"
: "${BASE_RPC:?set BASE_RPC to a Base Sepolia RPC that serves eth_getProof (Alchemy/Infura), e.g. https://base-sepolia.g.alchemy.com/v2/<key> — the public sepolia.base.org will NOT work}"
: "${ROUTER_ID:?set ROUTER_ID to the deployed Stellar RISC Zero verifier router (see header)}"

echo ">>> checking reviewed bridge guest image ID"
BUILT_IMAGE_ID=$(cd "$PROVER" && ./run-host -- --print-image-id)
bridge_image_id_check "$IMAGE_ID" "$BUILT_IMAGE_ID" "$IMAGE_ID_PIN"
echo "    guest image id = $IMAGE_ID"

base_tx_settle_delay() {
  [ "$BASE_TX_SETTLE_DELAY" = "0" ] || sleep "$BASE_TX_SETTLE_DELAY"
}

is_base_inflight_limit() {
  printf '%s\n' "$1" | grep -qi 'in-flight transaction limit'
}

base_retry_notice() {
  local attempt=$1
  echo "    Base RPC in-flight transaction limit; retry $attempt/$BASE_TX_MAX_ATTEMPTS in ${BASE_TX_RETRY_DELAY}s" >&2
}

base_create() {
  local out err err_text combined rc attempt
  for attempt in $(seq 1 "$BASE_TX_MAX_ATTEMPTS"); do
    err=$(mktemp)
    set +e
    out=$(cd "$EVM" && forge create \
      --rpc-url "$BASE_RPC" --private-key "$PRIVATE_KEY" --broadcast --json "$@" 2>"$err")
    rc=$?
    set -e
    err_text=$(cat "$err")
    rm -f "$err"
    if [ "$rc" -eq 0 ]; then
      [ -z "$err_text" ] || printf '%s\n' "$err_text" >&2
      printf '%s\n' "$out"
      base_tx_settle_delay
      return 0
    fi
    combined="$out
$err_text"
    if is_base_inflight_limit "$combined" && [ "$attempt" -lt "$BASE_TX_MAX_ATTEMPTS" ]; then
      base_retry_notice "$attempt"
      sleep "$BASE_TX_RETRY_DELAY"
      continue
    fi
    printf '%s\n' "$combined" >&2
    return "$rc"
  done
}

casts() {
  local out err err_text combined rc attempt
  for attempt in $(seq 1 "$BASE_TX_MAX_ATTEMPTS"); do
    err=$(mktemp)
    set +e
    out=$(cast send --rpc-url "$BASE_RPC" --private-key "$PRIVATE_KEY" "$@" 2>"$err")
    rc=$?
    set -e
    err_text=$(cat "$err")
    rm -f "$err"
    if [ "$rc" -eq 0 ]; then
      [ -z "$err_text" ] || printf '%s\n' "$err_text" >&2
      printf '%s\n' "$out"
      base_tx_settle_delay
      return 0
    fi
    combined="$out
$err_text"
    if is_base_inflight_limit "$combined" && [ "$attempt" -lt "$BASE_TX_MAX_ATTEMPTS" ]; then
      base_retry_notice "$attempt"
      sleep "$BASE_TX_RETRY_DELAY"
      continue
    fi
    printf '%s\n' "$combined" >&2
    return "$rc"
  done
}

run_begin "Base"
echo "==> 0. context"
ADMIN_EVM=$(cast wallet address --private-key "$PRIVATE_KEY")
echo "    base deployer = $ADMIN_EVM   rpc = $BASE_RPC"
STELLAR_ADDR=$(stellar keys address "$IDENTITY" 2>/dev/null) \
  || { stellar keys generate "$IDENTITY" --network "$NETWORK"; stellar keys fund "$IDENTITY" --network "$NETWORK"; STELLAR_ADDR=$(stellar keys address "$IDENTITY"); }
XLM_SAC=$(stellar contract id asset --asset native --network "$NETWORK")
echo "    stellar admin = $STELLAR_ADDR   router = $ROUTER_ID"
stage "context"
note "base deployer" "$ADMIN_EVM"
note "base rpc"      "$BASE_RPC"
note "stellar admin" "$STELLAR_ADDR"
note "router"        "$ROUTER_ID"
endstage

# Manage nonces explicitly: public RPCs lag on pending-nonce, which makes rapid back-to-back txs
# collide ("replacement transaction underpriced"). We assign sequential nonces ourselves.
NONCE=$(cast nonce "$ADMIN_EVM" --rpc-url "$BASE_RPC")
echo "==> 1. deploy MockUSDC + MosaicBridge on Base Sepolia, mint (nonce base $NONCE)"
USDC_JSON=$(base_create test/mocks/MockUSDC.sol:MockUSDC --nonce "$NONCE")
USDC=$(printf '%s\n' "$USDC_JSON" | jq -r .deployedTo); NONCE=$((NONCE+1))
BRIDGE_JSON=$(base_create src/MosaicBridge.sol:MosaicBridge \
  --nonce "$NONCE" --constructor-args "$ADMIN_EVM" "[$ASSET_ID]" "[$USDC]")
BRIDGE=$(printf '%s\n' "$BRIDGE_JSON" | jq -r .deployedTo); NONCE=$((NONCE+1))   # --constructor-args last
echo "    usdc = $USDC   bridge = $BRIDGE"
state_set BASE_DEPOSITOR "$ADMIN_EVM"
state_set BASE_USDC "$USDC"
state_set BASE_BRIDGE "$BRIDGE"
state_set BASE_RPC "$BASE_RPC"
state_set ROUTER_ID "$ROUTER_ID"
casts --nonce "$NONCE" "$USDC" 'mint(address,uint256)' "$ADMIN_EVM" "$AMOUNT" >/dev/null; NONCE=$((NONCE+1))
stage "deploy (Base)"
note "MockUSDC"     "$USDC"
note "MosaicBridge" "$BRIDGE"
note "minted"       "$AMOUNT to $ADMIN_EVM"
note "registered"  "asset $ASSET_ID -> $USDC (constructor)"
note "explorer"    "https://sepolia.basescan.org/address/$BRIDGE"
endstage

echo "==> 2. approve + shield $AMOUNT of asset $ASSET_ID"
casts --nonce "$NONCE" "$USDC" 'approve(address,uint256)' "$BRIDGE" "$AMOUNT" >/dev/null; NONCE=$((NONCE+1))
TXH=$(casts --nonce "$NONCE" "$BRIDGE" 'shield(uint32,uint256,bytes32)' "$ASSET_ID" "$AMOUNT" "$OWNER_TAG" --json | jq -r .transactionHash); NONCE=$((NONCE+1))
DEPOSIT_BLOCK=$(cast receipt "$TXH" blockNumber --rpc-url "$BASE_RPC")
echo "    shield tx = $TXH   deposit block = $DEPOSIT_BLOCK"
state_set BASE_SHIELD_TX "$TXH"
stage "shield (Base)"
note "asset / amount" "$ASSET_ID / $AMOUNT"
note "owner tag"      "$OWNER_TAG"
note "shield tx"      "$TXH"
note "deposit block"  "$DEPOSIT_BLOCK"
note "tx explorer"    "https://sepolia.basescan.org/tx/$TXH"
endstage

echo "==> 3. prove the deposit NOW, while its block is in the eth_getProof window -> seal + journal"
# Prove immediately against the deposit's (recent => in-window) block. The seal/journal commit to
# (blockNumber, blockHash) and never expire, so we HOLD them and only mint after that block finalizes
# (next step). This gives true finality safety WITHOUT an archive getProof RPC: the proof's getProof
# happens now while in-window, and the finality wait is a pure block-number check (no getProof).
( cd "$PROVER" && RUST_LOG=info ./run-host -- \
    --rpc-url "$BASE_RPC" --bridge "$BRIDGE" --deposit-id "$DEPOSIT_ID" --block "$DEPOSIT_BLOCK" \
    --prove --out-dir "$PROVER/out" )
SEAL="$PROVER/out/seal.bin"; JOURNAL="$PROVER/out/journal.bin"
[ -s "$SEAL" ] && [ -s "$JOURNAL" ] || { echo "ERROR: proving did not emit seal/journal"; exit 1; }
# Journal word 0 = commitment.id (block number in the low 8 bytes); word 1 = block hash. `-c` keeps
# each value on ONE line (xxd -p wraps at 60 hex cols, which would corrupt the 64-hex block hash).
BLOCK=$(( 16#$(xxd -p -c 8 -s 24 -l 8 "$JOURNAL") ))
BLOCK_HASH=$(xxd -p -c 32 -s 32 -l 32 "$JOURNAL")
echo "    proof committed to block $BLOCK ($BLOCK_HASH)"
stage "prove"
note "seal"          "$SEAL"
note "journal"       "$JOURNAL"
note "committed block" "$BLOCK"
note "block hash"    "$BLOCK_HASH"
endstage

# Finality toggle. DEFAULT (WAIT_FINALITY=0) is FAST: mint immediately against the proven (recent,
# not-yet-finalized) block — quick, reorg-risky, demo only. WAIT_FINALITY=1 holds the proof until its
# block finalizes on Base (true finality; just a number check, no getProof, so no proof-window limit).
WAIT_FINALITY="${WAIT_FINALITY:-0}"
if [ "$WAIT_FINALITY" = "1" ]; then
  echo "    WAIT_FINALITY=1: holding proof; waiting for block $BLOCK to finalize on Base (~10-15 min)..."
  while :; do
    FIN=$(cast block finalized --field number --rpc-url "$BASE_RPC" 2>/dev/null || echo 0)
    [ -n "$FIN" ] && [ "$FIN" -ge "$BLOCK" ] && break
    echo "      finalized=$FIN target=$BLOCK; sleeping 30s"
    sleep 30
  done
else
  echo "    fast mode (default): minting immediately without waiting for finality (reorg-risk; demo only)"
  echo "      → set WAIT_FINALITY=1 for the reorg-safe finality wait"
fi

echo "==> 4. deploy + configure settlement on Stellar testnet"
( cd "$CONTRACT" && stellar contract build --optimize >/dev/null )
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
# The bridged asset is Dual (real Stellar custody via the XLM SAC stand-in + a Base side). Assets
# are constructor-only (immutable) now — no post-deploy register_asset.
ASSETS_JSON="[{\"asset_id\":$ASSET_ID,\"token\":\"$XLM_SAC\",\"kind\":\"Dual\"}]"
CID=$(stellar contract deploy --wasm "$WASM" --source "$IDENTITY" --network "$NETWORK" \
  -- --lift_vk-file-path "$VKS/lift_vk" --unshield_vk-file-path "$VKS/unshield_vk" \
  --cancel_vk-file-path "$VKS/cancel_vk" --join_vk-file-path "$VKS/join_vk" --admin "$STELLAR_ADDR" \
  --assets "$ASSETS_JSON" --pairs '[]')
echo "    settlement = $CID"
state_set BASE_SETTLEMENT_CID "$CID"
state_set BASE_DEPOSIT_BLOCK "$BLOCK"
inv --send yes -- configure_base_bridge \
  --router "$ROUTER_ID" --image_id "$IMAGE_ID" --config_id "$CONFIG_ID" --bridge "${BRIDGE#0x}" >/dev/null
# The trust anchor: the relayer attests the Base block hash (the one the proof committed to).
inv --send yes -- attest_base_block --block_number "$BLOCK" --block_hash "$BLOCK_HASH" >/dev/null
stage "configure (Stellar)"
note "settlement contract" "$CID"
note "asset $ASSET_ID -> token" "$XLM_SAC"
note "base bridge"   "${BRIDGE#0x}"
note "attested block" "$BLOCK"
note "explorer"      "https://stellar.expert/explorer/$NETWORK/contract/$CID"
endstage

echo "==> 5. shield_from_base: verify the proof on-chain and mint the note"
ROOT_BEFORE=$(inv -- root 2>/dev/null | tr -d '"')
inv --send yes -- shield_from_base --seal-file-path "$SEAL" --journal-file-path "$JOURNAL" >/dev/null
ROOT_AFTER=$(inv -- root 2>/dev/null | tr -d '"')
stage "shield_from_base (Stellar)"
note "root before" "$ROOT_BEFORE"
note "root after"  "$ROOT_AFTER"
note "result"      "$([ "$ROOT_BEFORE" != "$ROOT_AFTER" ] && echo 'note minted — tree root advanced' || echo 'FAILED — root did not advance')"
endstage

echo "==> done"
echo "    settlement = $CID"
echo "    root before = $ROOT_BEFORE"
echo "    root after   = $ROOT_AFTER"
state_set BASE_STELLAR_ADDR "$STELLAR_ADDR"
state_set BASE_ROOT_AFTER "$ROOT_AFTER"
state_set BASE_LAST_RUN "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
print_summary "Base"
[ "$ROOT_BEFORE" != "$ROOT_AFTER" ] \
  && echo "    OK: tree root advanced — the Base deposit is now an active note on Stellar." \
  || { echo "    FAIL: root did not advance"; exit 1; }
