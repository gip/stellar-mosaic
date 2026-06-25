#!/usr/bin/env bash
# ABSOLUTE-WORST-CASE order-book transaction on Stellar TESTNET. Builds a FULL 64-deep SELL book from
# 64 real resting maker orders, then submits one BUY taker that crosses the book and fills the 4-fill
# cap (MAX_FILLS_PER_SUBMIT) — the most expensive submit_order possible (verify + load 64 + 8 proceeds
# inserts + store ~60 + rest). Prints that transaction's id and its assembled instruction count, and
# asserts it is within the 400M per-tx budget (the network also rejects any tx over 400M).
#
# Requires: stellar CLI + funded testnet identity (default m0); fixtures/book_worst/ from
# scripts/gen_worstcase_fixtures.sh. ~130 transactions; takes several minutes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WB="$ROOT/contracts/settlement/tests/fixtures/book_worst"
CONTRACT="$ROOT/contracts/settlement"
VKS="$ROOT/backend/vks"
NETWORK="${NETWORK:-testnet}"; IDENTITY="${IDENTITY:-m0}"; BUDGET=400000000; N=64
export PATH="$HOME/.cargo/bin:$PATH"
inv() { stellar contract invoke --id "$CID" --source "$IDENTITY" --network "$NETWORK" "$@"; }

echo ">>> network=$NETWORK identity=$IDENTITY  (full $N-deep book + 4-fill taker)"
ADMIN=$(stellar keys address "$IDENTITY")
XLM_SAC=$(stellar contract id asset --asset native --network "$NETWORK")
( cd "$CONTRACT" && stellar contract build >/dev/null 2>&1 )
WASM="$CONTRACT/target/wasm32v1-none/release/settlement.wasm"
# Assets/pairs are constructor-only (immutable): assets 1,2 as Dual (XLM SAC) + canonical pair id 0.
ASSETS_JSON="[{\"asset_id\":1,\"token\":\"$XLM_SAC\",\"kind\":\"Dual\"},{\"asset_id\":2,\"token\":\"$XLM_SAC\",\"kind\":\"Dual\"}]"
CID=$(stellar contract deploy --wasm "$WASM" --source "$IDENTITY" --network "$NETWORK" \
  -- --lift_vk-file-path "$VKS/lift_vk" --unshield_vk-file-path "$VKS/unshield_vk" \
  --cancel_vk-file-path "$VKS/cancel_vk" --join_vk-file-path "$VKS/join_vk" --admin "$ADMIN" \
  --assets "$ASSETS_JSON" --pairs '[{"base_asset":1,"quote_asset":2}]')
echo "    CONTRACT: $CID"

echo ">>> [shield] 64 maker notes (10 a1 each) + taker note (2400 a2)  -> 65-leaf tree"
for i in $(seq 0 $((N-1))); do
  ot=$(xxd -p -c64 "$WB/owner_tag_m$i")
  inv --send yes -- shield --from "$ADMIN" --asset_id 1 --amount 10 --owner_tag "$ot" >/dev/null
  [ $((i % 16)) -eq 0 ] && echo "    ...shielded maker $i"
done
ot=$(xxd -p -c64 "$WB/owner_tag_t")
inv --send yes -- shield --from "$ADMIN" --asset_id 2 --amount 2400 --owner_tag "$ot" >/dev/null

echo ">>> [build book] submit 64 maker SELLs (each rests; no opposing side yet)"
for i in $(seq 0 $((N-1))); do
  inv --send yes -- submit_order --proof-file-path "$WB/proof_m$i" --public_inputs-file-path "$WB/public_inputs_m$i" >/dev/null
  [ $((i % 16)) -eq 0 ] && echo "    ...rested maker $i"
done
echo "    SELL book depth: $(inv -- book --pair_id 0 --side 1 2>/dev/null | grep -o '"remaining_in"' | wc -l | tr -d ' ')"

echo ">>> [WORST CASE] taker BUY crosses the full book and fills the 4-fill cap"
# Assembled instruction count (simulate path), then the real submission + its tx id.
set +e
XDR=$(stellar contract invoke --id "$CID" --source "$IDENTITY" --network "$NETWORK" --build-only -- \
  submit_order --proof-file-path "$WB/proof_t" --public_inputs-file-path "$WB/public_inputs_t" 2>/dev/null)
INSTR=$(printf '%s' "$XDR" | stellar tx simulate --source-account "$IDENTITY" --network "$NETWORK" 2>/dev/null \
        | stellar tx decode 2>/dev/null | grep -o '"instructions"[^0-9]*[0-9]\{1,\}' | grep -o '[0-9]\{1,\}$' | head -1)
set -e
OUT=$(inv --send yes -- submit_order --proof-file-path "$WB/proof_t" --public_inputs-file-path "$WB/public_inputs_t" 2>&1)
TXID=$(printf '%s' "$OUT" | grep -o 'tx/[0-9a-f]\{64\}' | head -1 | cut -d/ -f2)

echo
echo ">>> RESULT (absolute worst case: full 64-deep book + 4 fills)"
if [ -n "${INSTR:-}" ]; then
  echo "    instructions: $INSTR  (~$(( INSTR / 4000000 ))% of 400M)"
  [ "$INSTR" -gt "$BUDGET" ] && { echo "    *** OVER 400M BUDGET ***"; }
fi
echo "    SELL book depth after fills: $(inv -- book --pair_id 0 --side 1 2>/dev/null | grep -o '"remaining_in"' | wc -l | tr -d ' ') (expect 60)"
echo "    TAKER TX ID: $TXID"
echo "    explorer:    https://stellar.expert/explorer/$NETWORK/tx/$TXID"
echo "    contract:    $CID"
echo "    NOTE: the network accepts a state-changing tx only if it fits 400M, so this submission is itself proof of being within budget."
