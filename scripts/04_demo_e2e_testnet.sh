#!/usr/bin/env bash
# WS4 end-to-end demo on Stellar TESTNET: the full shield -> place_order -> settle_match ->
# unshield-proceeds lifecycle, with REAL UltraHonk proofs submitted as real transactions. This is the
# authoritative version: real network, real submission, real CPU metering. It also asserts the two
# WS4 invariants the cutover cares about: the **nullifier accumulator root advances** through the
# match, and a **stale-root match reverts** (replaying settle_match hits the accumulator CAS).
#
# WHY RUN-TIME PROOF GENERATION: WS4 binds the live ledger clock — place_order requires
# now <= expiry <= now + MAX_ORDER_TTL (7d), and settle_match binds `now` within 300s of ledger time.
# So proofs are generated against the current clock via tests/fixtures/ws4/regen.py into a temp dir
# (the committed fixtures are never touched): place + the proceeds-unshield with expiry=now+6d, and
# the match regenerated with a fresh `now` immediately before it is submitted.
#
# Scenario (regen.py scenario B + G): A shields 100 a1 + 1600 a2 under two notes, places both orders,
# crosses them with settle_match (taker fully filled), then UNSHIELDS the taker's 1600-a2 proceeds
# note — a note that exists only as a tree leaf, whose Merkle path the indexer rebuilds from event
# history (impossible without the path server). Both asset-ids map to the native XLM SAC.
#
# Requires: stellar CLI + a funded testnet identity (default m0) AND the pinned proving toolchain
# (nargo 1.0.0-beta.9, bb v0.87.0) since proofs are generated at run time.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/contracts/settlement/tests/fixtures/ws4"   # committed VKs
REGEN="$SRC/regen.py"
CONTRACT="$ROOT/contracts/settlement"
NETWORK="${NETWORK:-testnet}"
IDENTITY="${IDENTITY:-m0}"
RPC="${RPC:-https://soroban-testnet.stellar.org}"
export PATH="$HOME/.nargo/bin:$HOME/.bb:$HOME/.cargo/bin:$PATH"

source "$ROOT/scripts/lib/e2e_state.sh"

# The taker withdraws its proceeds here — must match the recipient bound in the unshield proof
# (regen.py scenario G uses this address). A contract address, so the XLM SAC credits it without a
# trustline.
DEMO_TO="CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"

FX="$(mktemp -d)"
trap 'rm -rf "$FX"; git -C "$ROOT" checkout -- circuits/lift/Prover.toml circuits/match/Prover.toml circuits/unshield/Prover.toml 2>/dev/null || true' EXIT

inv() { stellar contract invoke --id "$CID" --source "$IDENTITY" --network "$NETWORK" "$@"; }
OT() { xxd -p -c64 "$FX/$1"; }
ledger_now() { curl -s "$RPC" -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | grep -o '"closeTime":"[0-9]*"' | grep -o '[0-9]*'; }

# Best-effort CPU instruction count for a state-changing call (assembled tx SorobanResources; the RPC
# cost.cpu_insns reads 0 on this protocol). Never fatal.
measure() {
  local label="$1"; shift
  set +e
  local xdr instr
  xdr=$(stellar contract invoke --id "$CID" --source "$IDENTITY" --network "$NETWORK" --build-only -- "$@" 2>/dev/null)
  instr=$(printf '%s' "$xdr" | stellar tx simulate --source-account "$IDENTITY" --network "$NETWORK" 2>/dev/null \
          | stellar tx decode 2>/dev/null | grep -o '"instructions"[^0-9]*[0-9]\{1,\}' | grep -o '[0-9]\{1,\}$' | head -1)
  set -e
  if [ -n "${instr:-}" ]; then LAST_CPU="$instr (~$(( instr / 4000000 ))% of 400M)"; else LAST_CPU="(unavailable)"; fi
  echo "    [$label] CPU (assembled): ${LAST_CPU}"
}

run_begin "Stellar"
echo ">>> network=$NETWORK identity=$IDENTITY"
ADMIN=$(stellar keys address "$IDENTITY" 2>/dev/null) \
  || { stellar keys generate "$IDENTITY" --network "$NETWORK"; stellar keys fund "$IDENTITY" --network "$NETWORK"; ADMIN=$(stellar keys address "$IDENTITY"); }
XLM_SAC=$(stellar contract id asset --asset native --network "$NETWORK")
echo "    admin/holder = $ADMIN ; native XLM SAC = $XLM_SAC"
state_set STELLAR_NETWORK "$NETWORK"; state_set STELLAR_IDENTITY "$IDENTITY"
state_set STELLAR_ADDR "$ADMIN"; state_set XLM_SAC "$XLM_SAC"
stage "context"; note "network" "$NETWORK"; note "identity" "$IDENTITY"; note "admin/holder" "$ADMIN"
note "native XLM SAC" "$XLM_SAC"; endstage

echo ">>> [build] witness bin + settlement wasm"
( cd "$ROOT/tools/indexer" && cargo build -q --bin witness )
( cd "$CONTRACT" && stellar contract build >/dev/null 2>&1 )
WASM="$CONTRACT/target/wasm32v1-none/release/settlement.wasm"
cp "$SRC/lift_vk" "$SRC/unshield_vk" "$SRC/match_vk" "$FX/"

EXP=$(( $(ledger_now) + 6*86400 ))
echo ">>> [gen] place + proceeds-unshield proofs (expiry=$EXP)"
WS4_FX="$FX" WS4_EXP="$EXP" python3 "$REGEN" tk_place mk_place life_unshield >/dev/null

echo ">>> [deploy] with the order/lift VK (op 1) + admin"
CID=$(stellar contract deploy --wasm "$WASM" --source "$IDENTITY" --network "$NETWORK" \
  -- --vk_bytes-file-path "$FX/lift_vk" --admin "$ADMIN")
echo "    SETTLEMENT CONTRACT: $CID"
state_set SETTLEMENT_CID "$CID"
stage "deploy"; note "settlement contract" "$CID"; note "admin" "$ADMIN"
note "explorer" "https://stellar.expert/explorer/$NETWORK/contract/$CID"; endstage

echo ">>> [setup] register unshield VK (op 2) + match VK (op 5) + map asset-ids 1,2 -> XLM SAC"
inv --send yes -- set_vk --op 2 --vk_bytes-file-path "$FX/unshield_vk" >/dev/null
inv --send yes -- set_vk --op 5 --vk_bytes-file-path "$FX/match_vk" >/dev/null
inv --send yes -- register_asset --asset_id 1 --token "$XLM_SAC" >/dev/null
inv --send yes -- register_asset --asset_id 2 --token "$XLM_SAC" >/dev/null
inv --send yes -- register_pair --base_asset 1 --quote_asset 2 >/dev/null
stage "setup"; note "VKs" "unshield (op 2), match (op 5)"; note "assets 1,2 -> token" "$XLM_SAC"
note "pair 0" "1/2"; endstage

echo ">>> [1. SHIELD] taker 100 a1 + maker 1600 a2  (advances the note tree)"
inv --send yes -- shield --from "$ADMIN" --asset_id 1 --amount 100  --owner_tag "$(OT tk_note_tag)" >/dev/null
inv --send yes -- shield --from "$ADMIN" --asset_id 2 --amount 1600 --owner_tag "$(OT mk_note_tag)" >/dev/null
stage "shield"; note "taker shields" "100 a1 -> leaf 0"; note "maker shields" "1600 a2 -> leaf 1"
note "note root" "$(inv -- root 2>/dev/null | tr -d '"')"; endstage

echo ">>> [2. PLACE] rest both orders in the order tree"
measure place_order:taker place_order --proof-file-path "$FX/tk_place_proof" --public_inputs-file-path "$FX/tk_place_pi"
inv --send yes -- place_order --proof-file-path "$FX/tk_place_proof" --public_inputs-file-path "$FX/tk_place_pi" >/dev/null
inv --send yes -- place_order --proof-file-path "$FX/mk_place_proof" --public_inputs-file-path "$FX/mk_place_pi" >/dev/null
NF_BEFORE=$(inv -- nullifier_root 2>/dev/null | tr -d '"')
stage "place"; note "taker order" "SELL 100 a1 @ >=1500 a2"; note "maker order" "SELL 1600 a2 @ >=100 a1"
note "place_order CPU" "${LAST_CPU}"; note "accumulator root" "$NF_BEFORE"; endstage

echo ">>> [3. SETTLE_MATCH] cross taker vs maker (fresh-now proof; one verify)"
WS4_FX="$FX" WS4_EXP="$EXP" WS4_NOW=$(( $(ledger_now) - 30 )) python3 "$REGEN" match >/dev/null
measure settle_match settle_match --proof-file-path "$FX/match_proof" --public_inputs-file-path "$FX/match_pi"
inv --send yes -- settle_match --proof-file-path "$FX/match_proof" --public_inputs-file-path "$FX/match_pi" >/dev/null
NF_AFTER=$(inv -- nullifier_root 2>/dev/null | tr -d '"')
[ "$NF_BEFORE" != "$NF_AFTER" ] || { echo "    *** FAIL: nullifier accumulator did not advance ***"; exit 1; }
echo "    accumulator advanced: $NF_BEFORE -> $NF_AFTER"
stage "settle_match"; note "trade" "taker fully filled vs maker"; note "settle_match CPU" "${LAST_CPU}"
note "accumulator root" "$NF_BEFORE -> $NF_AFTER (advanced)"; endstage

echo ">>> [3b. STALE-ROOT CHECK] replaying settle_match must revert (accumulator CAS)"
set +e
inv --send yes -- settle_match --proof-file-path "$FX/match_proof" --public_inputs-file-path "$FX/match_pi" >/dev/null 2>&1
REPLAY_RC=$?
set -e
[ "$REPLAY_RC" -ne 0 ] || { echo "    *** FAIL: replayed settle_match was accepted (double-spend!) ***"; exit 1; }
echo "    replay correctly rejected (stale nullifier_root_in)"
stage "stale-root"; note "replayed settle_match" "rejected (NullifierUsed / stale root)"; endstage

echo ">>> [4. UNSHIELD] taker withdraws its 1600-a2 proceeds note to $DEMO_TO"
# Seed the recipient's SAC balance entry with a direct transfer first: `unshield`'s nested SAC call
# would otherwise CREATE that entry, and the CLI under-estimates the refundable (rent) fee for a new
# entry buried in a contract invocation (InsufficientRefundableFee at submit). With the entry already
# present, the unshield only bumps it — sim matches execution.
stellar contract invoke --id "$XLM_SAC" --source "$IDENTITY" --network "$NETWORK" --send yes \
  -- transfer --from "$ADMIN" --to "$DEMO_TO" --amount 1 >/dev/null
TO_BEFORE=$(stellar contract invoke --id "$XLM_SAC" --source "$IDENTITY" --network "$NETWORK" -- balance --id "$DEMO_TO" 2>/dev/null | tr -d '"')
measure unshield unshield --to "$DEMO_TO" --proof_bytes-file-path "$FX/life_unshield_proof" --public_inputs-file-path "$FX/life_unshield_pi"
inv --send yes -- unshield --to "$DEMO_TO" --proof_bytes-file-path "$FX/life_unshield_proof" --public_inputs-file-path "$FX/life_unshield_pi" >/dev/null
TO_AFTER=$(stellar contract invoke --id "$XLM_SAC" --source "$IDENTITY" --network "$NETWORK" -- balance --id "$DEMO_TO" 2>/dev/null | tr -d '"')
stage "unshield"; note "recipient" "$DEMO_TO"; note "withdrew" "1600 a2 (match-created proceeds note)"
note "balance" "$TO_BEFORE -> $TO_AFTER (expected +1600)"; note "unshield CPU" "${LAST_CPU}"; endstage

echo
echo ">>> RESULT"
echo "    recipient ($DEMO_TO) XLM balance: $TO_BEFORE -> $TO_AFTER (expected +1600)"
echo "    accumulator root advanced through the match; replay rejected."
echo "    contract: $CID"
echo "    Full WS4 shield -> place -> settle_match -> unshield lifecycle executed on $NETWORK."
state_set STELLAR_ROOT "$(inv -- root 2>/dev/null | tr -d '"')"
state_set STELLAR_LAST_RUN "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
print_summary "Stellar"
