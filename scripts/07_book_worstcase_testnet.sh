#!/usr/bin/env bash
# ABSOLUTE-WORST-CASE WS4 transaction on Stellar TESTNET: one `settle_match` that crosses a taker
# against the full 3-maker cap AND re-rests a remainder — the most expensive proof-verifying call in
# the protocol (one UltraHonk verify, 4 order-tree memberships, 4 sequential nullifier-IMT inserts,
# 4 proceeds note mints, + 1 remainder order insert). Builds the scenario with 4 real place_order
# transactions, then submits the match, prints its assembled instruction count, and asserts it is
# within the 400M per-tx budget (the network also rejects any tx over 400M).
#
# Like script 06, proofs are generated at RUN TIME against the live ledger clock (WS4 binds now/expiry
# to it), into a temp dir — the committed contract-test fixtures are never touched. The 4 place proofs
# use expiry=now+6d; the worst-case match is regenerated with a fresh `now` right before submission.
#
# Scenario (regen.py scenario F): taker gives 300 a1 wanting >=4500 a2; makers give 1600 + 1600 + 800
# a2 for 100 + 100 + 50 a1. Taker pays 250 a1, receives 4000 a2, re-rests 50 a1 @ 750 a2 (exact ratio).
# Assets 1,2 both map to the native XLM SAC (one SAC, no trustlines).
#
# Requires: stellar CLI + a funded testnet identity (default m0) AND the pinned proving toolchain
# (nargo 1.0.0-beta.9, bb v0.87.0).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/contracts/settlement/tests/fixtures/ws4"
REGEN="$SRC/regen.py"
CONTRACT="$ROOT/contracts/settlement"
NETWORK="${NETWORK:-testnet}"; IDENTITY="${IDENTITY:-m0}"; BUDGET=400000000
RPC="${RPC:-https://soroban-testnet.stellar.org}"
export PATH="$HOME/.nargo/bin:$HOME/.bb:$HOME/.cargo/bin:$PATH"

FX="$(mktemp -d)"
trap 'rm -rf "$FX"; git -C "$ROOT" checkout -- circuits/lift/Prover.toml circuits/match/Prover.toml 2>/dev/null || true' EXIT
inv() { stellar contract invoke --id "$CID" --source "$IDENTITY" --network "$NETWORK" "$@"; }
OT() { xxd -p -c64 "$FX/$1"; }
ledger_now() { curl -s "$RPC" -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | grep -o '"closeTime":"[0-9]*"' | grep -o '[0-9]*'; }

echo ">>> network=$NETWORK identity=$IDENTITY  (1 taker x 3 makers + remainder; the WS4 worst case)"
ADMIN=$(stellar keys address "$IDENTITY")
XLM_SAC=$(stellar contract id asset --asset native --network "$NETWORK")
echo ">>> [build] witness bin + settlement wasm"
( cd "$ROOT/tools/indexer" && cargo build -q --bin witness )
( cd "$CONTRACT" && stellar contract build >/dev/null 2>&1 )
WASM="$CONTRACT/target/wasm32v1-none/release/settlement.wasm"
cp "$SRC/lift_vk" "$SRC/match_vk" "$FX/"

EXP=$(( $(ledger_now) + 6*86400 ))
echo ">>> [gen] 4 place proofs (expiry=$EXP)"
WS4_FX="$FX" WS4_EXP="$EXP" python3 "$REGEN" wt_place wm0_place wm1_place wm2_place >/dev/null

echo ">>> [deploy] with the lift/order VK (op 1) + admin; set match VK (op 5)"
CID=$(stellar contract deploy --wasm "$WASM" --source "$IDENTITY" --network "$NETWORK" \
  -- --vk_bytes-file-path "$FX/lift_vk" --admin "$ADMIN")
echo "    CONTRACT: $CID"
inv --send yes -- set_vk --op 5 --vk_bytes-file-path "$FX/match_vk" >/dev/null
inv --send yes -- register_asset --asset_id 1 --token "$XLM_SAC" >/dev/null
inv --send yes -- register_asset --asset_id 2 --token "$XLM_SAC" >/dev/null
inv --send yes -- register_pair --base_asset 1 --quote_asset 2 >/dev/null

echo ">>> [shield] taker 300 a1 + makers 1600/1600/800 a2"
inv --send yes -- shield --from "$ADMIN" --asset_id 1 --amount 300  --owner_tag "$(OT wmatch_t_tag)"  >/dev/null
inv --send yes -- shield --from "$ADMIN" --asset_id 2 --amount 1600 --owner_tag "$(OT wmatch_m0_tag)" >/dev/null
inv --send yes -- shield --from "$ADMIN" --asset_id 2 --amount 1600 --owner_tag "$(OT wmatch_m1_tag)" >/dev/null
inv --send yes -- shield --from "$ADMIN" --asset_id 2 --amount 800  --owner_tag "$(OT wmatch_m2_tag)" >/dev/null

echo ">>> [place_order] rest the taker order + 3 maker orders"
inv --send yes -- place_order --proof-file-path "$FX/wt_place_proof"  --public_inputs-file-path "$FX/wt_place_pi"  >/dev/null
for i in 0 1 2; do
  inv --send yes -- place_order --proof-file-path "$FX/wm${i}_place_proof" --public_inputs-file-path "$FX/wm${i}_place_pi" >/dev/null
done

echo ">>> [gen] worst-case settle_match proof with a fresh now"
WS4_FX="$FX" WS4_EXP="$EXP" WS4_NOW=$(( $(ledger_now) - 30 )) python3 "$REGEN" wmatch >/dev/null

echo ">>> [WORST CASE] settle_match: taker x 3 makers + remainder re-rest"
set +e
XDR=$(stellar contract invoke --id "$CID" --source "$IDENTITY" --network "$NETWORK" --build-only -- \
  settle_match --proof-file-path "$FX/wmatch_proof" --public_inputs-file-path "$FX/wmatch_pi" 2>/dev/null)
INSTR=$(printf '%s' "$XDR" | stellar tx simulate --source-account "$IDENTITY" --network "$NETWORK" 2>/dev/null \
        | stellar tx decode 2>/dev/null | grep -o '"instructions"[^0-9]*[0-9]\{1,\}' | grep -o '[0-9]\{1,\}$' | head -1)
set -e
OUT=$(inv --send yes -- settle_match --proof-file-path "$FX/wmatch_proof" --public_inputs-file-path "$FX/wmatch_pi" 2>&1)
TXID=$(printf '%s' "$OUT" | grep -o 'tx/[0-9a-f]\{64\}' | head -1 | cut -d/ -f2)

echo
echo ">>> RESULT (absolute worst case: 1 taker x 3 makers + remainder)"
if [ -n "${INSTR:-}" ]; then
  echo "    instructions: $INSTR  (~$(( INSTR / 4000000 ))% of 400M)"
  [ "$INSTR" -gt "$BUDGET" ] && echo "    *** OVER 400M BUDGET ***"
fi
echo "    TAKER MATCH TX ID: $TXID"
echo "    explorer:          https://stellar.expert/explorer/$NETWORK/tx/$TXID"
echo "    contract:          $CID"
echo "    NOTE: the network accepts a state-changing tx only if it fits 400M, so this submission is itself proof of being within budget."
