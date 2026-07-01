#!/usr/bin/env bash
# Rebuild absolutely every local artifact from source, chaining the existing numbered scripts
# instead of duplicating their logic. Order follows their dependencies:
#   1. pnpm install                    - node_modules (08 copies Noir runtime WASM out of it)
#   2. 01_build_prove.sh                - circuit toolchain sanity check (Milestone 0: spend circuit)
#   3. 08_build_web_artifacts.sh        - settlement.wasm, MosaicBridge ABI, VKs, lift/unshield/
#                                         cancel/join + wallet-helper ACIR, Noir runtime WASM
#                                         -> backend/artifacts, frontend/public, packages/sdk/assets
#   4. 05_gen_book_fixtures.sh          - contracts/settlement/tests/fixtures/book/*
#   5. 09_gen_join_fixtures.sh          - contracts/settlement/tests/fixtures/join_*
#   6. pnpm -r build                    - @mosaic/sdk, @mosaic/cli, @mosaic/mcp
#   7. pnpm --filter frontend build     - the Vite app
#   8. bridge-prover cargo build        - RISC Zero guest+host (skip with --skip-bridge-prover)
#   9. cargo test -p settlement         - final check that everything just built is consistent
#
# NOT chained here: contracts/settlement/tests/fixtures/regen.sh. It's a manual playbook (derive
# each order's membership witness, hand-edit circuits/lift/Prover.toml, then source it and call
# `prove a`/`prove b` yourself) — see its header. Only needed if the lift/unshield public-input
# layout changes; run it by hand when that happens.
#
# Requires the pinned toolchain (see CLAUDE.md): nargo 1.0.0-beta.9, bb v0.87.0, stellar CLI,
# foundry (forge), and — unless --skip-bridge-prover — Rust 1.96 + RISC Zero 3.0 (r0vm/cargo-risczero).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.nargo/bin:$HOME/.bb:$HOME/.cargo/bin:$PATH"

SKIP_BRIDGE_PROVER=0
for arg in "$@"; do
  case "$arg" in
    --skip-bridge-prover) SKIP_BRIDGE_PROVER=1 ;;
    *) echo "usage: $0 [--skip-bridge-prover]" >&2; exit 1 ;;
  esac
done

echo ">>> [1/9] pnpm install"
( cd "$ROOT" && pnpm install )

echo ">>> [2/9] circuit toolchain sanity check (01_build_prove.sh)"
bash "$ROOT/scripts/01_build_prove.sh"

echo ">>> [3/9] web artifacts: contract wasm, VKs, circuits, Noir wasm (08_build_web_artifacts.sh)"
bash "$ROOT/scripts/08_build_web_artifacts.sh"

echo ">>> [4/9] order-book test fixtures (05_gen_book_fixtures.sh)"
bash "$ROOT/scripts/05_gen_book_fixtures.sh"

echo ">>> [5/9] join test fixtures (09_gen_join_fixtures.sh)"
bash "$ROOT/scripts/09_gen_join_fixtures.sh"

echo ">>> [6/9] TypeScript packages (@mosaic/sdk, @mosaic/cli, @mosaic/mcp)"
( cd "$ROOT" && pnpm -r build )

echo ">>> [7/9] frontend production build"
( cd "$ROOT" && pnpm --filter frontend build )

if [ "$SKIP_BRIDGE_PROVER" -eq 1 ]; then
  echo ">>> [8/9] bridge-prover: SKIPPED (--skip-bridge-prover)"
else
  echo ">>> [8/9] bridge-prover (RISC Zero guest + host)"
  ( cd "$ROOT/bridge-prover" && cargo build )
fi

echo ">>> [9/9] verify: cargo test -p settlement"
( cd "$ROOT/contracts/settlement" && cargo test -p settlement )

echo
echo "ALL ARTIFACTS REBUILT."
echo "Reminder: contracts/settlement/tests/fixtures/regen.sh is manual-only — run it yourself if the"
echo "lift/unshield circuits' public-input layout changed."
