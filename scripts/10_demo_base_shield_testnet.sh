#!/usr/bin/env bash
# End-to-end demo: shield USDC on BASE SEPOLIA and mint the matching note on STELLAR TESTNET, via a
# real RISC Zero / Steel Groth16 proof verified on Soroban. This is the WS8 orchestration of the
# Base-shield bridge (docs/base-bridge.md): Base deposit -> prove -> attest block -> shield_from_base.
#
# It ties together the pieces built in WS1 (evm/MosaicBridge.sol), WS2/WS6 (bridge-prover), and WS4
# (settlement.shield_from_base). The full flow needs live infra that is NOT bundled here:
#
#   PREREQUISITES (export these or the script stops with an explanation):
#     - foundry (forge, cast) + a funded BASE SEPOLIA key:   PRIVATE_KEY=0x...
#     - the RISC Zero prover stack for Groth16 (r0vm/Docker, or RISC0_PROVER=bonsai + BONSAI_*),
#       OR set USE_BOUNDLESS=1 and wire the marketplace (see bridge-prover/README.md) — not automated.
#     - stellar CLI + a funded testnet identity (default IDENTITY=m0; auto-funded via friendbot).
#     - the Nethermind RISC Zero verifier ROUTER deployed on Stellar testnet, and its address in
#       ROUTER_ID. Deploy it once from vendor/stellar-risc0-verifier:
#         ./scripts/manage.sh deploy-router   -n testnet -a <acct> --min-delay 0
#         ./scripts/manage.sh deploy-verifier -n testnet -a <acct>
#         ./scripts/manage.sh schedule-add-verifier -n testnet -a <acct> --selector <sel>
#       (the selector is the first 4 bytes of the Groth16 seal; see their docs/architecture.md).
#
# Deliberately minimal for a robust live run: one fresh bridge, one shield (depositId 0), asset id 1
# mapped to the native XLM SAC on Stellar (the protocol only needs a registered id; Base-USDC is
# assumed equivalent to Stellar-USDC per the one-way peg). Amounts are tiny.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVM="$ROOT/evm"
PROVER="$ROOT/bridge-prover"
CONTRACT="$ROOT/contracts/settlement"
FIX="$CONTRACT/tests/fixtures"
export PATH="$HOME/.cargo/bin:$HOME/.foundry/bin:$PATH"

# --- config (override via env) ---
BASE_RPC="${BASE_RPC:-https://sepolia.base.org}"
USDC="${USDC:-0x036CbD53842c5426634e7929541eC2318f3dCF7e}" # Circle USDC on Base Sepolia
NETWORK="${NETWORK:-testnet}"
IDENTITY="${IDENTITY:-m0}"
ASSET_ID="${ASSET_ID:-1}"
AMOUNT="${AMOUNT:-1000000}"                  # 1 USDC (6 dp)
DEPOSIT_ID="${DEPOSIT_ID:-0}"                # fresh bridge -> first deposit is 0
# owner_tag = an opaque BN254 Fr element (< r). A real wallet derives Poseidon(pk_o, rho); for the
# demo any small constant works (it only governs who can later spend the minted note).
OWNER_TAG="${OWNER_TAG:-0x1111111111111111111111111111111111111111111111111111111111111111}"
# Pinned guest image id + Base Sepolia config digest (regenerate via bridge-prover print_journal_fixture).
IMAGE_ID="${IMAGE_ID:-333e192f991c82a12d4fbf779342c918af4eca4d8eba66908f2ac020c46d26a5}"
CONFIG_ID="${CONFIG_ID:-3519660d6ecbd34367740f5ca18449cba8b389594f69f177bbf21c46e505c61e}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: '$1' not found on PATH"; exit 1; }; }
need forge; need cast; need stellar; need jq
: "${PRIVATE_KEY:?set PRIVATE_KEY to a funded Base Sepolia key}"
: "${ROUTER_ID:?set ROUTER_ID to the deployed Stellar RISC Zero verifier router (see header)}"

echo "==> 0. context"
ADMIN_EVM=$(cast wallet address --private-key "$PRIVATE_KEY")
echo "    base deployer = $ADMIN_EVM   rpc = $BASE_RPC"
STELLAR_ADDR=$(stellar keys address "$IDENTITY" 2>/dev/null) \
  || { stellar keys generate "$IDENTITY" --network "$NETWORK"; stellar keys fund "$IDENTITY" --network "$NETWORK"; STELLAR_ADDR=$(stellar keys address "$IDENTITY"); }
XLM_SAC=$(stellar contract id asset --asset native --network "$NETWORK")
echo "    stellar admin = $STELLAR_ADDR   router = $ROUTER_ID"

echo "==> 1. deploy MosaicBridge on Base Sepolia + register USDC"
BRIDGE=$(forge create "$EVM/src/MosaicBridge.sol:MosaicBridge" \
  --root "$EVM" --rpc-url "$BASE_RPC" --private-key "$PRIVATE_KEY" --broadcast --json \
  --constructor-args "$ADMIN_EVM" | jq -r .deployedTo)
echo "    bridge = $BRIDGE"
cast send "$BRIDGE" 'registerAsset(uint32,address)' "$ASSET_ID" "$USDC" \
  --rpc-url "$BASE_RPC" --private-key "$PRIVATE_KEY" >/dev/null

echo "==> 2. approve + shield $AMOUNT of asset $ASSET_ID"
cast send "$USDC" 'approve(address,uint256)' "$BRIDGE" "$AMOUNT" \
  --rpc-url "$BASE_RPC" --private-key "$PRIVATE_KEY" >/dev/null
TXH=$(cast send "$BRIDGE" 'shield(uint32,uint256,bytes32)' "$ASSET_ID" "$AMOUNT" "$OWNER_TAG" \
  --rpc-url "$BASE_RPC" --private-key "$PRIVATE_KEY" --json | jq -r .transactionHash)
BLOCK=$(cast receipt "$TXH" blockNumber --rpc-url "$BASE_RPC")
BLOCK_HASH=$(cast receipt "$TXH" blockHash --rpc-url "$BASE_RPC")
echo "    shield tx = $TXH   block = $BLOCK   hash = $BLOCK_HASH"

echo "==> 3. prove the Shielded event (Groth16) -> seal + journal"
# Prove against a RECENT block (the deposit lives in current state; pinning the deposit's block
# fails once it ages out of the RPC's eth_getProof window). The block the proof commits to is read
# back from the journal and is what we attest below.
( cd "$PROVER" && RUST_LOG=info cargo run --release -p host -- \
    --rpc-url "$BASE_RPC" --bridge "$BRIDGE" --deposit-id "$DEPOSIT_ID" \
    --prove --out-dir "$PROVER/out" )
SEAL="$PROVER/out/seal.bin"; JOURNAL="$PROVER/out/journal.bin"
[ -s "$SEAL" ] && [ -s "$JOURNAL" ] || { echo "ERROR: proving did not emit seal/journal"; exit 1; }
# Journal word 0 = commitment.id (block number in low 8 bytes); word 1 = block hash.
BLOCK=$(( 16#$(xxd -p -s 24 -l 8 "$JOURNAL") ))
BLOCK_HASH=$(xxd -p -s 32 -l 32 "$JOURNAL")
echo "    proof committed to block $BLOCK ($BLOCK_HASH)"

echo "==> 4. deploy + configure settlement on Stellar testnet"
( cd "$CONTRACT" && stellar contract build >/dev/null )
WASM="$CONTRACT/target/wasm32v1-none/release/settlement.wasm"
inv() { stellar contract invoke --id "$CID" --source "$IDENTITY" --network "$NETWORK" "$@"; }
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
echo "    root before = $ROOT_BEFORE"
echo "    root after   = $ROOT_AFTER"
[ "$ROOT_BEFORE" != "$ROOT_AFTER" ] \
  && echo "    OK: tree root advanced — the Base deposit is now an active note on Stellar." \
  || { echo "    FAIL: root did not advance"; exit 1; }
