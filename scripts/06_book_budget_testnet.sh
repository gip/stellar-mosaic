#!/usr/bin/env bash
# Functional + budget test on Stellar TESTNET for the WS4 order lifecycle. Runs the real WS4
# entrypoints (place_order, settle_match, cancel_order) as REAL transactions with REAL UltraHonk
# proofs, and asserts every proof-verifying entrypoint stays within the 400M per-transaction
# instruction budget.
#
# WHY RUN-TIME PROOF GENERATION: unlike the WS1 book, WS4 binds the live clock — place_order requires
# now <= expiry <= now + MAX_ORDER_TTL (7d), and settle_match binds `now` within 300s of ledger time.
# So the committed contract-test fixtures (expiry=1000/now=100) cannot drive a testnet run; this
# script regenerates proofs against the current clock via tests/fixtures/ws4/regen.py into a temp dir
# (the committed fixtures are never touched). Place proofs are made once with expiry=now+6d; each
# settle_match proof is regenerated with a fresh `now` immediately before it is submitted.
#
# TWO INDEPENDENT BUDGET CHECKS:
#   (1) The network rejects any tx over 400M instructions, so a SUCCESSFUL `--send yes` submission is
#       proof-by-execution that the call fit the budget. `set -e` aborts on any reject.
#   (2) `measure_assert` assembles + simulates each call and prints its exact instruction count + % of
#       400M; if a (readable) count exceeds the budget, the script fails loudly.
#
# Two scenarios, each on its own fresh contract:
#   TRADE  (scenario B): shield taker 100 a1 + maker 1600 a2 -> place taker -> place maker ->
#          settle_match (taker fully filled vs maker). Measures place_order + settle_match.
#   CANCEL (scenario E): shield 100 a1 -> place SELL -> cancel_order. Measures cancel_order.
# Assets 1 and 2 both map to the native XLM SAC — the protocol distinguishes assets by id, so one SAC
# avoids trustline setup.
#
# Requires: stellar CLI + a funded testnet identity (default m0) AND the pinned proving toolchain
# (nargo 1.0.0-beta.9, bb v0.87.0) since proofs are generated at run time.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/contracts/settlement/tests/fixtures/ws4"   # committed VKs live here
REGEN="$SRC/regen.py"
CONTRACT="$ROOT/contracts/settlement"
NETWORK="${NETWORK:-testnet}"
IDENTITY="${IDENTITY:-m0}"
RPC="${RPC:-https://soroban-testnet.stellar.org}"
BUDGET=400000000
export PATH="$HOME/.nargo/bin:$HOME/.bb:$HOME/.cargo/bin:$PATH"

# Run-time fixtures go to a temp dir; restore the circuits' Prover.toml inputs that regen rewrites.
FX="$(mktemp -d)"
trap 'rm -rf "$FX"; git -C "$ROOT" checkout -- circuits/lift/Prover.toml circuits/match/Prover.toml circuits/cancel/Prover.toml 2>/dev/null || true' EXIT

FAILED=0
inv() { stellar contract invoke --id "$CID" --source "$IDENTITY" --network "$NETWORK" "$@"; }
OT() { xxd -p -c64 "$FX/$1"; }
# Current ledger close time (the clock the contract checks `now`/`expiry` against).
ledger_now() { curl -s "$RPC" -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | grep -o '"closeTime":"[0-9]*"' | grep -o '[0-9]*'; }

# Assemble + simulate a call, print its instruction count + % of 400M, and FAIL the run if a readable
# count exceeds the budget. An unreadable count is non-fatal — the submission below is the real gate.
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
      echo "    [$label] CPU instructions: $instr  (~${pct}% of 400M)  *** OVER BUDGET ***"; FAILED=1
    else
      echo "    [$label] CPU instructions: $instr  (~${pct}% of 400M)  OK"
    fi
  else
    echo "    [$label] CPU: (count unavailable; relying on network acceptance of the submission)"
  fi
}

echo ">>> network=$NETWORK identity=$IDENTITY  budget=${BUDGET} (400M)"
ADMIN=$(stellar keys address "$IDENTITY" 2>/dev/null) \
  || { stellar keys generate "$IDENTITY" --network "$NETWORK"; stellar keys fund "$IDENTITY" --network "$NETWORK"; ADMIN=$(stellar keys address "$IDENTITY"); }
XLM_SAC=$(stellar contract id asset --asset native --network "$NETWORK")
echo "    admin/holder = $ADMIN ; native XLM SAC = $XLM_SAC"

echo ">>> [build] witness bin + settlement wasm"
( cd "$ROOT/tools/indexer" && cargo build -q --bin witness )
( cd "$CONTRACT" && stellar contract build >/dev/null 2>&1 )
WASM="$CONTRACT/target/wasm32v1-none/release/settlement.wasm"
cp "$SRC/lift_vk" "$SRC/match_vk" "$SRC/cancel_vk" "$FX/"   # VKs are clock-independent; reuse committed

# Place proofs with a 6-day expiry (valid for placement now). The match is regenerated later with a
# fresh `now`. EXP is chosen from the live ledger clock.
EXP=$(( $(ledger_now) + 6*86400 ))
echo ">>> [gen] place proofs (expiry=$EXP) for TRADE + CANCEL"
WS4_FX="$FX" WS4_EXP="$EXP" python3 "$REGEN" tk_place mk_place cancel_place cancel >/dev/null

# A fresh desk: deploy with the lift/order VK (op 1) + admin, register assets 1,2 + canonical pair 0.
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
deploy_desk; TRADE_CID="$CID"
inv --send yes -- set_vk --op 5 --vk_bytes-file-path "$FX/match_vk" >/dev/null

echo ">>> [TRADE] shield taker 100 a1 + maker 1600 a2"
inv --send yes -- shield --from "$ADMIN" --asset_id 1 --amount 100  --owner_tag "$(OT tk_note_tag)" >/dev/null
inv --send yes -- shield --from "$ADMIN" --asset_id 2 --amount 1600 --owner_tag "$(OT mk_note_tag)" >/dev/null

echo ">>> [place_order] taker (SELL 100 a1 @ >=1500 a2) then maker (SELL 1600 a2 @ >=100 a1)"
measure_assert place_order:taker place_order --proof-file-path "$FX/tk_place_proof" --public_inputs-file-path "$FX/tk_place_pi"
inv --send yes -- place_order --proof-file-path "$FX/tk_place_proof" --public_inputs-file-path "$FX/tk_place_pi" >/dev/null
inv --send yes -- place_order --proof-file-path "$FX/mk_place_proof" --public_inputs-file-path "$FX/mk_place_pi" >/dev/null

echo ">>> [gen] settle_match proof with a fresh now (submitted within the 300s skew window)"
WS4_FX="$FX" WS4_EXP="$EXP" WS4_NOW=$(( $(ledger_now) - 30 )) python3 "$REGEN" match >/dev/null
echo ">>> [settle_match] taker fully filled vs maker (1 taker x 1 maker, no remainder)"
measure_assert settle_match:1x1 settle_match --proof-file-path "$FX/match_proof" --public_inputs-file-path "$FX/match_pi"
inv --send yes -- settle_match --proof-file-path "$FX/match_proof" --public_inputs-file-path "$FX/match_pi" >/dev/null

# ===========================================================================
# CANCEL: place_order -> cancel_order  (measures cancel_order; no `now` binding)
# ===========================================================================
echo ">>> [CANCEL] deploy + set cancel VK (op 3)"
deploy_desk; CANCEL_CID="$CID"
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
  echo "    FAIL: a measured call exceeded the 400M budget (see *** OVER BUDGET *** above)."; exit 1
fi
