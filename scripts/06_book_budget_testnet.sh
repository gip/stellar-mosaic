#!/usr/bin/env bash
# Functional + budget test on Stellar TESTNET for the WS4 order lifecycle. Runs the real WS4
# entrypoints (place_order, settle_match, cancel_order) as REAL transactions with the REAL UltraHonk
# proofs in tests/fixtures/ws4/, and asserts every proof-verifying entrypoint stays within the 400M
# per-transaction instruction budget.
#
# TWO INDEPENDENT BUDGET CHECKS:
#   (1) The network itself rejects any tx over 400M instructions, so a SUCCESSFUL `--send yes`
#       submission is proof-by-execution that the call fit the budget. `set -e` aborts on any reject.
#   (2) `measure_assert` additionally assembles + simulates each call and prints its exact instruction
#       count and % of 400M; if a count is readable AND exceeds the budget, the script fails loudly.
#
# Two independent fixtures, each on its own fresh contract (each proof binds the tree/accumulator
# state of its own standalone scenario, so they are not mixed on one deployment):
#   TRADE  (scenario B): shield taker 100 a1 + maker 1600 a2 -> place taker -> place maker ->
#          settle_match (taker fully filled vs maker). Measures place_order + settle_match.
#   CANCEL (scenario E): shield 100 a1 -> place SELL -> cancel_order. Measures cancel_order.
# Assets 1 and 2 both map to the native XLM SAC (as in script 04) — the protocol distinguishes assets
# by id, so one SAC avoids trustline setup. Regenerate fixtures with scripts/05.
#
# Requires: stellar CLI + a funded testnet identity (default m0). No Noir/bb toolchain needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FX="$ROOT/contracts/settlement/tests/fixtures/ws4"
CONTRACT="$ROOT/contracts/settlement"
NETWORK="${NETWORK:-testnet}"
IDENTITY="${IDENTITY:-m0}"
BUDGET=400000000
export PATH="$HOME/.cargo/bin:$PATH"

FAILED=0
inv() { stellar contract invoke --id "$CID" --source "$IDENTITY" --network "$NETWORK" "$@"; }

# Assemble + simulate a call, print its instruction count and % of 400M, and FAIL the run if the
# (readable) count exceeds the budget. Never fatal on an unreadable count — the submission below is
# the authoritative gate.
measure_assert() {
  local label="$1"; shift
  set +e
  local xdr instr pct
  xdr=$(stellar contract invoke --id "$CID" --source "$IDENTITY" --network "$NETWORK" --build-only -- "$@" 2>/dev/null)
  instr=$(printf '%s' "$xdr" | stellar tx simulate --source-account "$IDENTITY" --network "$NETWORK" 2>/dev/null \
          | stellar tx decode 2>/dev/null | grep -o '"instructions"[^0-9]*[0-9]\{1,\}' | grep -o '[0-9]\{1,\}$' | head -1)
  set -e
  if [ -n "${instr:-}" ]; then
    pct=$(( instr / 4000000 ))
    if [ "$instr" -gt "$BUDGET" ]; then
      echo "    [$label] CPU instructions: $instr  (~${pct}% of 400M)  *** OVER BUDGET ***"
      FAILED=1
    else
      echo "    [$label] CPU instructions: $instr  (~${pct}% of 400M)  OK"
    fi
  else
    echo "    [$label] CPU: (count unavailable; relying on network acceptance of the submission)"
  fi
}

OT() { xxd -p -c64 "$FX/$1"; }   # owner tag (32 bytes) as hex

echo ">>> network=$NETWORK identity=$IDENTITY  budget=${BUDGET} (400M)"
ADMIN=$(stellar keys address "$IDENTITY" 2>/dev/null) \
  || { stellar keys generate "$IDENTITY" --network "$NETWORK"; stellar keys fund "$IDENTITY" --network "$NETWORK"; ADMIN=$(stellar keys address "$IDENTITY"); }
XLM_SAC=$(stellar contract id asset --asset native --network "$NETWORK")
echo "    admin/holder = $ADMIN ; native XLM SAC = $XLM_SAC"

echo ">>> [build] settlement contract -> wasm"
( cd "$CONTRACT" && stellar contract build >/dev/null 2>&1 )
WASM="$CONTRACT/target/wasm32v1-none/release/settlement.wasm"

# A fresh desk: deploy with the lift/order VK (op 1) + admin, register assets 1,2 -> XLM SAC + the
# canonical pair (id 0). Echoes the contract id into CID.
deploy_desk() {
  CID=$(stellar contract deploy --wasm "$WASM" --source "$IDENTITY" --network "$NETWORK" \
    -- --vk_bytes-file-path "$FX/lift_vk" --admin "$ADMIN")
  inv --send yes -- register_asset --asset_id 1 --token "$XLM_SAC" >/dev/null
  inv --send yes -- register_asset --asset_id 2 --token "$XLM_SAC" >/dev/null
  inv --send yes -- register_pair --base_asset 1 --quote_asset 2 >/dev/null
}

# ===========================================================================
# TRADE: place_order x2 -> settle_match  (measures place_order + settle_match)
# ===========================================================================
echo ">>> [TRADE] deploy + set match VK (op 5)"
deploy_desk
TRADE_CID="$CID"
inv --send yes -- set_vk --op 5 --vk_bytes-file-path "$FX/match_vk" >/dev/null

echo ">>> [TRADE] shield taker 100 a1 + maker 1600 a2  (reproduces the proofs' root)"
inv --send yes -- shield --from "$ADMIN" --asset_id 1 --amount 100  --owner_tag "$(OT tk_note_tag)" >/dev/null
inv --send yes -- shield --from "$ADMIN" --asset_id 2 --amount 1600 --owner_tag "$(OT mk_note_tag)" >/dev/null

echo ">>> [place_order] taker (SELL 100 a1 @ >=1500 a2) then maker (SELL 1600 a2 @ >=100 a1)"
measure_assert place_order:taker place_order --proof-file-path "$FX/tk_place_proof" --public_inputs-file-path "$FX/tk_place_pi"
inv --send yes -- place_order --proof-file-path "$FX/tk_place_proof" --public_inputs-file-path "$FX/tk_place_pi" >/dev/null
inv --send yes -- place_order --proof-file-path "$FX/mk_place_proof" --public_inputs-file-path "$FX/mk_place_pi" >/dev/null

echo ">>> [settle_match] taker fully filled vs maker (1 taker x 1 maker, no remainder)"
measure_assert settle_match:1x1 settle_match --proof-file-path "$FX/match_proof" --public_inputs-file-path "$FX/match_pi"
inv --send yes -- settle_match --proof-file-path "$FX/match_proof" --public_inputs-file-path "$FX/match_pi" >/dev/null

# ===========================================================================
# CANCEL: place_order -> cancel_order  (measures cancel_order)
# ===========================================================================
echo ">>> [CANCEL] deploy + set cancel VK (op 3)"
deploy_desk
CANCEL_CID="$CID"
inv --send yes -- set_vk --op 3 --vk_bytes-file-path "$FX/cancel_vk" >/dev/null

echo ">>> [CANCEL] shield 100 a1 -> place SELL -> cancel"
inv --send yes -- shield --from "$ADMIN" --asset_id 1 --amount 100 --owner_tag "$(OT cancel_note_tag)" >/dev/null
inv --send yes -- place_order --proof-file-path "$FX/cancel_place_proof" --public_inputs-file-path "$FX/cancel_place_pi" >/dev/null
measure_assert cancel_order cancel_order --proof-file-path "$FX/cancel_proof" --public_inputs-file-path "$FX/cancel_pi"
inv --send yes -- cancel_order --proof-file-path "$FX/cancel_proof" --public_inputs-file-path "$FX/cancel_pi" >/dev/null

echo
echo ">>> RESULT"
echo "    trade contract:  $TRADE_CID"
echo "    cancel contract: $CANCEL_CID"
if [ "$FAILED" -eq 0 ]; then
  echo "    PASS: place_order, settle_match, and cancel_order executed on $NETWORK within the 400M budget."
else
  echo "    FAIL: a measured call exceeded the 400M budget (see *** OVER BUDGET *** above)."
  exit 1
fi
