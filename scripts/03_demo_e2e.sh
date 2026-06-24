#!/usr/bin/env bash
# WS4 end-to-end lifecycle on the LOCAL Soroban host (no testnet): regenerate the WS4 proof fixtures,
# then run the full shield -> place_order -> settle_match flow against the real contract + real
# UltraHonk verifier in `cargo test`. Every membership witness (note/order paths, the per-note nonce,
# nullifier-IMT inserts) is derived by the off-chain path server (tools/indexer `witness` bin), so the
# proofs are made against exactly the tree/accumulator state the contract reaches.
#
# This is the local counterpart of scripts/04 (the testnet version). The lifecycle assertions live in
# contracts/settlement/tests/ws4.rs::full_flow_shield_place_place_settle_match (shield x2 -> place x2
# -> settle_match: note/order/accumulator roots all agree contract == indexer == proof; proceeds
# minted; accumulator advanced through every consumption).
#
# Requires the pinned toolchain on PATH: nargo 1.0.0-beta.9, bb v0.87.0, and cargo.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.nargo/bin:$HOME/.bb:$HOME/.cargo/bin:$PATH"

echo ">>> regenerate all WS4 proof fixtures (scripts/05)"
"$ROOT/scripts/05_gen_book_fixtures.sh"

echo ">>> run the local-host WS4 lifecycle (cargo test)"
( cd "$ROOT/contracts/settlement" && cargo test --test ws4 -- --nocapture )

echo ">>> done — shield -> place_order -> settle_match verified on the local host with real proofs."
