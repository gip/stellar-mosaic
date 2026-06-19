#!/usr/bin/env bash
# End-to-end demo on Stellar TESTNET: the full shield -> order -> settle -> unshield lifecycle, with
# the same REAL UltraHonk proofs the local-host demo uses (tests/fixtures/demo/), submitted as real
# transactions. This is the authoritative version: real network, real submission, real CPU metering.
#
# WHY THE LOCAL-HOST PROOFS WORK UNCHANGED ON TESTNET: the order/unshield proofs bind the protocol
# asset-IDs (the u32 1 and 2) and the Merkle ROOT, not token addresses. The on-chain tree's compress
# is deterministic, so shielding the same notes in the same order on a fresh contract reproduces the
# exact roots R2/R4 the proofs were made against. The membership witnesses inside those proofs were
# reconstructed by the path server (tools/indexer) — see scripts/03_demo_e2e.sh.
#
# ASSET SIMPLIFICATION (deliberate, for a robust live run): both protocol asset-ids map to the native
# XLM Stellar Asset Contract. The protocol distinguishes asset 1 from asset 2 by id; using two
# distinct real tokens would only add SAC issuance + trustline setup and prove nothing extra about
# the lifecycle or the path server. Amounts are in stroops (100 and 2000 = tiny).
#
# Requires: stellar CLI, a funded testnet identity (default m0). No Noir/bb toolchain needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="$ROOT/contracts/settlement/tests/fixtures/demo"
CONTRACT="$ROOT/contracts/settlement"
NETWORK="${NETWORK:-testnet}"
IDENTITY="${IDENTITY:-m0}"
export PATH="$HOME/.cargo/bin:$PATH"

# The address A withdraws its proceeds to — must match the recipient bound in the unshield proof
# (scripts/03_demo_e2e.sh used this address). It is a contract address, so the XLM SAC can credit it
# without a trustline.
DEMO_TO="CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"

OTA="$(xxd -p -c64 "$DEMO/owner_tag_a")"
OTB="$(xxd -p -c64 "$DEMO/owner_tag_b")"

inv() { stellar contract invoke --id "$CID" --source "$IDENTITY" --network "$NETWORK" "$@"; }

# Authoritative CPU instruction count for a state-changing call (RPC cost.cpu_insns reads 0 on this
# protocol; the real number is in the assembled tx's SorobanResources). Best-effort + never fatal.
measure() {
  local label="$1"; shift
  set +e
  local xdr instr pct
  xdr=$(stellar contract invoke --id "$CID" --source "$IDENTITY" --network "$NETWORK" --build-only -- "$@" 2>/dev/null)
  instr=$(printf '%s' "$xdr" | stellar tx simulate --source-account "$IDENTITY" --network "$NETWORK" 2>/dev/null \
          | stellar tx decode 2>/dev/null | grep -o '"instructions"[^0-9]*[0-9]\{1,\}' | grep -o '[0-9]\{1,\}$' | head -1)
  set -e
  if [ -n "${instr:-}" ]; then
    pct=$(( instr / 4000000 ))
    echo "    [$label] CPU instructions (assembled): $instr  (~${pct}% of 400M)"
  else
    echo "    [$label] CPU: (count unavailable; see explorer link below)"
  fi
}

echo ">>> network=$NETWORK identity=$IDENTITY"
ADMIN=$(stellar keys address "$IDENTITY" 2>/dev/null) \
  || { stellar keys generate "$IDENTITY" --network "$NETWORK"; stellar keys fund "$IDENTITY" --network "$NETWORK"; ADMIN=$(stellar keys address "$IDENTITY"); }
XLM_SAC=$(stellar contract id asset --asset native --network "$NETWORK")
echo "    admin/holder = $ADMIN"
echo "    native XLM SAC = $XLM_SAC"

echo ">>> [build] settlement contract -> wasm"
( cd "$CONTRACT" && stellar contract build >/dev/null 2>&1 )
WASM="$CONTRACT/target/wasm32v1-none/release/settlement.wasm"

echo ">>> [deploy] with the order/lift VK + admin"
CID=$(stellar contract deploy --wasm "$WASM" --source "$IDENTITY" --network "$NETWORK" \
  -- --vk_bytes-file-path "$DEMO/vk" --admin "$ADMIN")
echo "    SETTLEMENT CONTRACT: $CID"

echo ">>> [setup] register unshield VK (op 2) + map asset-ids 1,2 -> XLM SAC"
inv --send yes -- set_vk --op 2 --vk_bytes-file-path "$DEMO/unshield_vk" >/dev/null
inv --send yes -- register_asset --asset_id 1 --token "$XLM_SAC" >/dev/null
inv --send yes -- register_asset --asset_id 2 --token "$XLM_SAC" >/dev/null

echo ">>> [1. SHIELD] A: 100 of asset1   B: 2000 of asset2  (advances on-chain tree to R2)"
inv --send yes -- shield --from "$ADMIN" --asset_id 1 --amount 100  --owner_tag "$OTA" >/dev/null
inv --send yes -- shield --from "$ADMIN" --asset_id 2 --amount 2000 --owner_tag "$OTB" >/dev/null
ROOT_HEX=$(inv -- root 2>/dev/null | tr -d '"')
echo "    on-chain root after shields (R2): $ROOT_HEX"
echo "    (proof A's bound root: 0x$(xxd -p -c64 -s 32 -l 32 "$DEMO/public_inputs_a"))"

echo ">>> [2/3. SETTLE] atomic two-proof trade (verifies BOTH order proofs in one tx)"
measure settle settle \
  --proof_a-file-path "$DEMO/proof_a" --public_inputs_a-file-path "$DEMO/public_inputs_a" \
  --proof_b-file-path "$DEMO/proof_b" --public_inputs_b-file-path "$DEMO/public_inputs_b"
inv --send yes -- settle \
  --proof_a-file-path "$DEMO/proof_a" --public_inputs_a-file-path "$DEMO/public_inputs_a" \
  --proof_b-file-path "$DEMO/proof_b" --public_inputs_b-file-path "$DEMO/public_inputs_b" >/dev/null
echo "    settle submitted; proceeds notes minted into the tree (root advances to R4)"

echo ">>> [4. UNSHIELD] A withdraws its SETTLE-created 2000 asset2 proceeds note to $DEMO_TO"
TO_BAL_BEFORE=$(stellar contract invoke --id "$XLM_SAC" --source "$IDENTITY" --network "$NETWORK" -- balance --id "$DEMO_TO" 2>/dev/null | tr -d '"')
measure unshield unshield --to "$DEMO_TO" \
  --proof_bytes-file-path "$DEMO/unshield_proof" --public_inputs-file-path "$DEMO/unshield_public_inputs"
inv --send yes -- unshield --to "$DEMO_TO" \
  --proof_bytes-file-path "$DEMO/unshield_proof" --public_inputs-file-path "$DEMO/unshield_public_inputs" >/dev/null
TO_BAL_AFTER=$(stellar contract invoke --id "$XLM_SAC" --source "$IDENTITY" --network "$NETWORK" -- balance --id "$DEMO_TO" 2>/dev/null | tr -d '"')

echo
echo ">>> RESULT"
echo "    recipient ($DEMO_TO) XLM balance: $TO_BAL_BEFORE -> $TO_BAL_AFTER (expected +2000)"
echo "    contract: $CID"
echo "    Full shield -> order -> settle -> unshield lifecycle executed on $NETWORK."
