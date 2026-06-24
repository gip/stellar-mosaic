#!/usr/bin/env bash
# Generate every WS4 proof fixture in contracts/settlement/tests/fixtures/ws4/ — the inputs for the
# contract tests (tests/{ws4,integration,join}.rs) AND the testnet budget scripts (06, 07).
#
# This is a thin wrapper over the single source of truth, tests/fixtures/ws4/regen.py, which drives
# tools/indexer's `witness` bin (off-chain tree/IMT witnesses) + `nargo` + `bb` so every proof is made
# against exactly the on-chain state the contract reaches. Scenarios:
#   A place_order   B shield->place->place->settle_match   C join   D unshield   E cancel
#   F WORST-CASE settle_match (1 taker x 3 makers + remainder, with its 4 place proofs)
#
# (Name is historical — WS4 replaced the on-chain Vec "book" with the order-commitment tree +
# event-derived book; these are the order place/match/cancel fixtures.)
# Requires the pinned toolchain: nargo 1.0.0-beta.9, bb v0.87.0.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.nargo/bin:$HOME/.bb:$HOME/.cargo/bin:$PATH"

echo ">>> build the off-chain witness bin (tools/indexer)"
( cd "$ROOT/tools/indexer" && cargo build -q --bin witness )

echo ">>> regenerate all WS4 fixtures (witness -> nargo -> bb)"
python3 "$ROOT/contracts/settlement/tests/fixtures/ws4/regen.py"

echo ">>> fixtures in contracts/settlement/tests/fixtures/ws4:"
ls -1 "$ROOT/contracts/settlement/tests/fixtures/ws4" | grep -vE '\.py$'
