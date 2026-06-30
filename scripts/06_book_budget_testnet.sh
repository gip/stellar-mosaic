#!/usr/bin/env bash
# Functional + budget test on Stellar TESTNET for the on-chain order book. Runs the real book
# lifecycle (shield -> submit resting sells -> submit a crossing buy that partially fills two makers
# -> cancel a resting order) as REAL transactions with the REAL UltraHonk proofs in
# tests/fixtures/book/, and asserts every proof-verifying entrypoint stays within the 400M
# per-transaction instruction budget.
#
# TWO INDEPENDENT BUDGET CHECKS:
#   (1) The network itself rejects any tx over 400M instructions, so a SUCCESSFUL `--send yes`
#       submission is proof-by-execution that the call fit the budget. `set -e` aborts on any reject.
#   (2) `measure` additionally assembles + simulates each call and prints its exact instruction count
#       and % of 400M; if a count is readable AND exceeds the budget, the script fails loudly.
#
# Scenario (pair: base = asset 1, quote = asset 2; both map to the native XLM SAC, as in script 04 —
# the protocol distinguishes assets by id, so one SAC is enough and avoids trustline setup):
#   shield 4 notes (S1=100 a1, S2=100 a1, B1=2400 a2, S3=50 a1) -> root R4 (the proofs' bound root)
#   submit S1 (SELL 100 a1 @1500), S2 (SELL 100 a1 @1600)             -> both rest
#   submit B1 (BUY 2400 a2 want 100 a1)  -> fills S1 fully + S2 partially (the worst-case submit), rests remainder
#   cancel S2                                                          -> returns S2's remaining locked funds
# S3's ORDER (expiry 5000, long past on testnet's real clock) is intentionally NOT submitted; its note
# is still shielded so the four proofs' root R4 is reproduced. prune_expired is covered by the local
# `cargo test --test book` (it is proof-free and trivially within budget).
#
# Requires: stellar CLI + a funded testnet identity (default m0). No Noir/bb toolchain needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOOK="$ROOT/contracts/settlement/tests/fixtures/book"
VKS="$ROOT/backend/vks"
CONTRACT="$ROOT/contracts/settlement"
NETWORK="${NETWORK:-testnet}"
IDENTITY="${IDENTITY:-m0}"
BUDGET=400000000
export PATH="$HOME/.cargo/bin:$PATH"

FAILED=0
inv() { stellar contract invoke --id "$CID" --source "$IDENTITY" --network "$NETWORK" "$@"; }

# Assemble + simulate a call, print its instruction count and % of 400M, and FAIL the run if the
# (readable) count exceeds the budget. Never fatal on an unreadable count — submission below is the
# authoritative gate.
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

OT_S1="$(xxd -p -c64 "$BOOK/owner_tag_s1")"
OT_S2="$(xxd -p -c64 "$BOOK/owner_tag_s2")"
OT_B1="$(xxd -p -c64 "$BOOK/owner_tag_b1")"
OT_S3="$(xxd -p -c64 "$BOOK/owner_tag_s3")"

echo ">>> network=$NETWORK identity=$IDENTITY  budget=${BUDGET} (400M)"
ADMIN=$(stellar keys address "$IDENTITY" 2>/dev/null) \
  || { stellar keys generate "$IDENTITY" --network "$NETWORK"; stellar keys fund "$IDENTITY" --network "$NETWORK"; ADMIN=$(stellar keys address "$IDENTITY"); }
XLM_SAC=$(stellar contract id asset --asset native --network "$NETWORK")
echo "    admin/holder = $ADMIN ; native XLM SAC = $XLM_SAC"

echo ">>> [build] settlement contract -> wasm"
( cd "$CONTRACT" && stellar contract build --optimize >/dev/null 2>&1 )
WASM="$CONTRACT/target/wasm32v1-none/release/settlement.wasm"

echo ">>> [deploy] order/lift VK + admin + assets 1,2 (Dual -> XLM SAC) + canonical pair (id 0)"
# Assets/pairs are constructor-only (immutable); there is no post-deploy register_asset/register_pair.
ASSETS_JSON="[{\"asset_id\":1,\"token\":\"$XLM_SAC\",\"kind\":\"Dual\"},{\"asset_id\":2,\"token\":\"$XLM_SAC\",\"kind\":\"Dual\"}]"
CID=$(stellar contract deploy --wasm "$WASM" --source "$IDENTITY" --network "$NETWORK" \
  -- --lift_vk-file-path "$VKS/lift_vk" --unshield_vk-file-path "$VKS/unshield_vk" \
  --cancel_vk-file-path "$VKS/cancel_vk" --join_vk-file-path "$VKS/join_vk" --admin "$ADMIN" \
  --assets "$ASSETS_JSON" --pairs '[{"base_asset":1,"quote_asset":2}]')
echo "    SETTLEMENT CONTRACT: $CID"

echo ">>> [shield] S1=100 a1, S2=100 a1, B1=2400 a2, S3=50 a1  (reproduces proofs' root R4)"
inv --send yes -- shield --from "$ADMIN" --asset_id 1 --amount 100  --owner_tag "$OT_S1" >/dev/null
inv --send yes -- shield --from "$ADMIN" --asset_id 1 --amount 100  --owner_tag "$OT_S2" >/dev/null
inv --send yes -- shield --from "$ADMIN" --asset_id 2 --amount 2400 --owner_tag "$OT_B1" >/dev/null
inv --send yes -- shield --from "$ADMIN" --asset_id 1 --amount 50   --owner_tag "$OT_S3" >/dev/null
echo "    on-chain root after shields: $(inv -- root 2>/dev/null | tr -d '"')"
echo "    (S1 proof bound root: 0x$(xxd -p -c64 -s 32 -l 32 "$BOOK/public_inputs_s1"))"

echo ">>> [submit S1, S2] two resting sells (no cross -> rest)"
measure_assert submit_order:S1 submit_order --proof-file-path "$BOOK/proof_s1" --public_inputs-file-path "$BOOK/public_inputs_s1"
inv --send yes -- submit_order --proof-file-path "$BOOK/proof_s1" --public_inputs-file-path "$BOOK/public_inputs_s1" >/dev/null
inv --send yes -- submit_order --proof-file-path "$BOOK/proof_s2" --public_inputs-file-path "$BOOK/public_inputs_s2" >/dev/null

echo ">>> [submit B1] crossing BUY: fills S1 fully + S2 partially (WORST-CASE submit), rests remainder"
measure_assert submit_order:B1_2fills submit_order --proof-file-path "$BOOK/proof_b1" --public_inputs-file-path "$BOOK/public_inputs_b1"
inv --send yes -- submit_order --proof-file-path "$BOOK/proof_b1" --public_inputs-file-path "$BOOK/public_inputs_b1" >/dev/null

echo ">>> [book state] SELL side after fills (expect S2 partial + S3-order-never-submitted):"
inv -- book --pair_id 0 --side 1 2>/dev/null | head -c 400; echo

echo ">>> [cancel S2] cancel proof returns S2's remaining locked funds"
measure_assert cancel_order:S2 cancel_order --pair_id 0 --side 1 --proof-file-path "$BOOK/cancel_proof" --public_inputs-file-path "$BOOK/cancel_public_inputs"
inv --send yes -- cancel_order --pair_id 0 --side 1 --proof-file-path "$BOOK/cancel_proof" --public_inputs-file-path "$BOOK/cancel_public_inputs" >/dev/null

echo
echo ">>> RESULT"
echo "    contract: $CID"
if [ "$FAILED" -eq 0 ]; then
  echo "    PASS: every order-book entrypoint executed on $NETWORK within the 400M instruction budget."
else
  echo "    FAIL: a measured call exceeded the 400M budget (see *** OVER BUDGET *** above)."
  exit 1
fi
