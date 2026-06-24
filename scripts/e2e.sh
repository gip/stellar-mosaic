#!/usr/bin/env bash
# e2e.sh — driver for the Stellar-Mosaic end-to-end testnet demos.
#
# It does NOT replace the demo scripts; it orchestrates them and remembers what they produced:
#   - scripts/04_demo_e2e_testnet.sh   Stellar leg: shield -> place_order -> settle_match -> unshield
#   - scripts/10_demo_base_shield_testnet.sh   Base leg: Base Sepolia shield -> mint note on Stellar
#
# What it gives you on top of the raw scripts:
#   status   inspect tools + env + state and say what is ready / blocked / should run next
#   show     print everything generated so far (contracts, addresses) with explorer links
#   stellar  run the Stellar leg, persisting its outputs
#   base     run the Base leg, persisting its outputs
#   all      run stellar then base, then print the combined summary
#   summary  re-print the per-stage tables from the last run(s) (optional leg filter)
#   regen    regenerate the UltraHonk proof fixtures (needs the Noir/bb toolchain)
#   reset    full clean slate: force-recompile everything + drop state; --new-stellar rotates address
#   clean    wipe persisted state in .e2e/  (committed fixtures are untouched)
#
# Persisted state lives in <repo>/.e2e/state.env (gitignored). See docs/e2e-testing.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$HOME/.foundry/bin:$HOME/.nargo/bin:$HOME/.bb:$PATH"
source "$ROOT/scripts/lib/e2e_state.sh"

# --- inputs / defaults (override via env) ---------------------------------------------------------
NETWORK="${NETWORK:-testnet}"
# Stellar identity; auto-created + friendbot-funded. If unset, use the one a prior `reset --new-stellar`
# generated (persisted as DRIVER_IDENTITY), else m0.
IDENTITY="${IDENTITY:-$(state_get DRIVER_IDENTITY)}"
IDENTITY="${IDENTITY:-m0}"
# Base RPC: MUST be set by the user to an eth_getProof-capable endpoint (Alchemy/Infura). There is no
# default on purpose — the public https://sepolia.base.org does NOT serve eth_getProof, so the prove
# step would fail. Set it like PRIVATE_KEY, e.g. https://base-sepolia.g.alchemy.com/v2/<key>.
BASE_RPC="${BASE_RPC:-}"
# The Nethermind RISC Zero verifier router already deployed on Stellar testnet (docs/base-bridge.md).
ROUTER_ID="${ROUTER_ID:-CB3ISULTPMQXHUH6BVRO7VQIQE3TTDRGSHWBJ72V7GRO6VF63BMGNWOU}"
# Base finality: 0 (default) = FAST (mint immediately, reorg-risky, demo only); 1 = wait for the
# proven block to finalize on Base (~10-15 min, reorg-safe).
WAIT_FINALITY="${WAIT_FINALITY:-0}"

SRC="$ROOT/contracts/settlement/tests/fixtures/ws4"   # committed WS4 VKs (04 generates proofs at run time)
EVM="$ROOT/evm"

# --- tiny ui --------------------------------------------------------------------------------------
b() { printf '\033[1m%s\033[0m' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no()   { printf '  \033[31m✗\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
hdr()  { printf '\n%s\n' "$(b "$1")"; }
have() { command -v "$1" >/dev/null 2>&1; }

# docker_alive — succeed only if the Docker daemon ANSWERS within ~8s. A wedged Docker Desktop leaves
# the daemon unresponsive: `docker info` then hangs forever, and so does the risc0 Groth16 wrap
# (it shells out to `docker run`). macOS has no `timeout`, so we use a background watchdog.
docker_alive() {
  have docker || return 1
  ( docker info >/dev/null 2>&1 ) & local pid=$! i=0
  while kill -0 "$pid" 2>/dev/null; do
    [ "$i" -ge 8 ] && { kill "$pid" 2>/dev/null; return 1; }
    sleep 1; i=$((i+1))
  done
  wait "$pid"
}

# --- readiness probes -----------------------------------------------------------------------------
# Stellar leg (WS4) needs the stellar CLI + the committed WS4 VKs + the proving toolchain (script 04
# generates proofs at run time against the live ledger clock — see its header).
fixtures_ready() {
  local f
  for f in lift_vk unshield_vk match_vk; do [ -s "$SRC/$f" ] || return 1; done
  have nargo && have bb
}
stellar_ready() { have stellar && fixtures_ready; }

# The EVM contracts depend on OpenZeppelin + forge-std, vendored into evm/lib (gitignored). The driver
# fetches the pinned versions on demand (evm/README.md). These are auto-fixable, so they are NOT a
# blocker — cmd_base fetches them before running.
evm_deps_ready() {
  [ -f "$EVM/lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol" ] && [ -d "$EVM/lib/forge-std/src" ]
}
fetch_evm_deps() {
  evm_deps_ready && return 0
  printf '%s\n' "$(b '>>> fetching pinned EVM deps into evm/lib (one-time, ~seconds)')"
  have git || { no "git missing — needed to fetch EVM deps"; return 1; }
  local oz="$EVM/lib/openzeppelin-contracts" fs="$EVM/lib/forge-std"
  if [ ! -f "$oz/contracts/token/ERC20/ERC20.sol" ]; then
    rm -rf "$oz"
    git clone --depth 1 --branch v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts "$oz" && rm -rf "$oz/.git"
  fi
  if [ ! -d "$fs/src" ]; then
    rm -rf "$fs"
    git clone --depth 1 --branch v1.9.4 https://github.com/foundry-rs/forge-std "$fs" && rm -rf "$fs/.git"
  fi
  evm_deps_ready
}

# Base leg needs foundry + a funded Base key + a getProof RPC + the risc0 prover stack + the router.
base_blockers() {
  local miss=()
  have forge || miss+=("forge (foundry)")
  have cast  || miss+=("cast (foundry)")
  have jq    || miss+=("jq")
  have cargo || miss+=("cargo (risc0 host build)")
  have docker || miss+=("docker (Groth16 wrap; or set RISC0_PROVER=bonsai)")
  [ -n "${PRIVATE_KEY:-}" ] || miss+=("PRIVATE_KEY env (funded Base Sepolia key)")
  [ -n "$BASE_RPC" ]        || miss+=("BASE_RPC env (Alchemy/Infura Base Sepolia URL; eth_getProof-capable — public RPC won't work)")
  [ -n "$ROUTER_ID" ]       || miss+=("ROUTER_ID env (deployed verifier router)")
  # ${arr[@]} on an empty array trips `set -u` on bash 3.2 (macOS) — guard the expansion.
  [ ${#miss[@]} -eq 0 ] || printf '%s\n' "${miss[@]}"
}

# =================================================================================================
cmd_status() {
  printf '%s   network=%s  identity=%s\n' "$(b 'Stellar Mosaic — e2e status')" "$NETWORK" "$IDENTITY"
  printf 'state file: %s\n' "$E2E_STATE_FILE"

  hdr "Toolchain"
  for t in stellar forge cast jq xxd cargo docker; do
    if have "$t"; then ok "$t"; else no "$t (missing)"; fi
  done

  hdr "Stellar leg  (scripts/04 — shield → place_order → settle_match → unshield)"
  have stellar     && ok "stellar CLI present"        || no "stellar CLI missing"
  { have nargo && have bb; } && ok "proving toolchain (nargo + bb) present" || no "nargo/bb missing (04 generates proofs at run time)"
  { [ -s "$SRC/lift_vk" ] && [ -s "$SRC/unshield_vk" ] && [ -s "$SRC/match_vk" ]; } && ok "WS4 VKs present" || no "WS4 VKs missing — run: $0 regen"
  if stellar_ready; then ok "$(b 'READY')  →  $0 stellar"; else warn "blocked (see above)"; fi

  hdr "Base leg  (scripts/10 — Base Sepolia shield → mint on Stellar)"
  local blockers; blockers="$(base_blockers)"
  if [ -z "$blockers" ]; then
    ok "$(b 'READY')  →  $0 base"
  else
    while IFS= read -r m; do [ -n "$m" ] && no "$m"; done <<< "$blockers"
    warn "set the missing items, then: $0 base"
  fi
  if evm_deps_ready; then ok "EVM deps vendored (evm/lib)"; else warn "EVM deps missing — fetched automatically on '$0 base'"; fi
  if [ "${RISC0_PROVER:-local}" != "local" ]; then ok "prover: RISC0_PROVER=$RISC0_PROVER (Docker not used)"
  elif docker_alive; then ok "Docker daemon responding (Groth16 wrap ok)"
  else no "Docker daemon NOT responding — restart: killall Docker && open -a Docker"; fi
  if [ "$WAIT_FINALITY" = "1" ]; then
    printf '  finality: WAIT_FINALITY=1 — reorg-safe, waits ~10-15 min for the block to finalize\n'
  else
    printf '  finality: fast (default) — mints immediately, reorg-risky; set WAIT_FINALITY=1 for the safe path\n'
  fi
  printf '  router: %s\n' "$ROUTER_ID"
  if [ -n "$BASE_RPC" ]; then
    printf '  base rpc: %s\n' "$BASE_RPC"
  else
    printf '  base rpc: (unset — export an Alchemy/Infura Base Sepolia URL, like PRIVATE_KEY)\n'
  fi

  hdr "Generated so far"
  if [ -s "$E2E_STATE_FILE" ]; then
    printf '  (%s) — full detail: %s show\n' "$E2E_STATE_FILE" "$0"
    state_has SETTLEMENT_CID      && printf '  stellar settlement: %s\n' "$(state_get SETTLEMENT_CID)"
    state_has BASE_SETTLEMENT_CID && printf '  base settlement:    %s\n' "$(state_get BASE_SETTLEMENT_CID)"
    state_has BASE_BRIDGE         && printf '  base bridge:        %s\n' "$(state_get BASE_BRIDGE)"
  else
    printf '  nothing yet — run a leg above.\n'
  fi
  printf '\n'
}

# =================================================================================================
link_stellar_c() { printf 'https://stellar.expert/explorer/%s/contract/%s' "$NETWORK" "$1"; }
link_stellar_a() { printf 'https://stellar.expert/explorer/%s/account/%s' "$NETWORK" "$1"; }
link_base()      { printf 'https://sepolia.basescan.org/address/%s' "$1"; }

row() { # row LABEL VALUE [LINK]
  [ -n "$2" ] || return 0
  if [ -n "${3:-}" ]; then printf '  %-22s %s\n      %s\n' "$1" "$2" "$3"
  else printf '  %-22s %s\n' "$1" "$2"; fi
}

cmd_show() {
  if [ ! -s "$E2E_STATE_FILE" ]; then
    printf 'No state yet (%s). Run "%s stellar" or "%s base" first.\n' "$E2E_STATE_FILE" "$0" "$0"
    return 0
  fi
  printf '%s\n' "$(b 'Generated artifacts')"

  hdr "Stellar leg (scripts/04)"
  row "network"       "$(state_get STELLAR_NETWORK)"
  row "identity"      "$(state_get STELLAR_IDENTITY)"
  row "address"       "$(state_get STELLAR_ADDR)"       "$(link_stellar_a "$(state_get STELLAR_ADDR)")"
  row "settlement"    "$(state_get SETTLEMENT_CID)"     "$(link_stellar_c "$(state_get SETTLEMENT_CID)")"
  row "XLM SAC"       "$(state_get XLM_SAC)"
  row "tree root"     "$(state_get STELLAR_ROOT)"
  row "last run (UTC)" "$(state_get STELLAR_LAST_RUN)"

  hdr "Base leg (scripts/10)"
  row "base depositor" "$(state_get BASE_DEPOSITOR)"    "$(link_base "$(state_get BASE_DEPOSITOR)")"
  row "MockUSDC"       "$(state_get BASE_USDC)"         "$(link_base "$(state_get BASE_USDC)")"
  row "MosaicBridge"   "$(state_get BASE_BRIDGE)"       "$(link_base "$(state_get BASE_BRIDGE)")"
  row "deposit block"  "$(state_get BASE_DEPOSIT_BLOCK)"
  row "base rpc"       "$(state_get BASE_RPC)"
  row "router"         "$(state_get ROUTER_ID)"         "$(link_stellar_c "$(state_get ROUTER_ID)")"
  row "settlement"     "$(state_get BASE_SETTLEMENT_CID)" "$(link_stellar_c "$(state_get BASE_SETTLEMENT_CID)")"
  row "stellar address" "$(state_get BASE_STELLAR_ADDR)" "$(link_stellar_a "$(state_get BASE_STELLAR_ADDR)")"
  row "tree root after" "$(state_get BASE_ROOT_AFTER)"
  row "last run (UTC)" "$(state_get BASE_LAST_RUN)"
  printf '\n'
}

# =================================================================================================
cmd_stellar() {
  stellar_ready || { printf 'Stellar leg not ready — run "%s status".\n' "$0"; exit 1; }
  printf '%s\n' "$(b '>>> running Stellar leg (scripts/04_demo_e2e_testnet.sh)')"
  NETWORK="$NETWORK" IDENTITY="$IDENTITY" "$ROOT/scripts/04_demo_e2e_testnet.sh"
}

cmd_base() {
  local blockers; blockers="$(base_blockers)"
  [ -z "$blockers" ] || { printf 'Base leg blocked:\n%s\nSee "%s status".\n' "$blockers" "$0"; exit 1; }
  if [ "${RISC0_PROVER:-local}" = "local" ] && ! docker_alive; then
    printf '%s\n' "$(no 'Docker is not responding — the Groth16 wrap would hang silently.')"
    printf '    restart it:  killall Docker && open -a Docker   (wait until `docker info` returns)\n'
    printf '    or offload proving to Bonsai: export RISC0_PROVER=bonsai BONSAI_API_KEY=... BONSAI_API_URL=...\n'
    exit 1
  fi
  fetch_evm_deps || { printf 'could not vendor EVM deps (evm/lib) — see evm/README.md\n'; exit 1; }
  printf '%s\n' "$(b '>>> running Base leg (scripts/10_demo_base_shield_testnet.sh)')"
  NETWORK="$NETWORK" IDENTITY="$IDENTITY" BASE_RPC="$BASE_RPC" ROUTER_ID="$ROUTER_ID" \
    WAIT_FINALITY="$WAIT_FINALITY" "$ROOT/scripts/10_demo_base_shield_testnet.sh"
}

cmd_all() { cmd_stellar; cmd_base; printf '\n%s\n' "$(b '>>> combined summary (both legs)')"; print_summary; }

cmd_summary() { print_summary "${2:-}"; }

cmd_regen() {
  printf '%s\n' "$(b '>>> regenerating WS4 proof fixtures (scripts/05 — needs nargo + bb)')"
  have nargo || { printf 'nargo not found — install nargo 1.0.0-beta.9 (see CLAUDE.md).\n'; exit 1; }
  "$ROOT/scripts/05_gen_book_fixtures.sh"
}

cmd_clean() {
  state_clear
  printf 'cleared %s (committed fixtures untouched).\n' "$E2E_STATE_DIR"
}

# Full clean-slate: force a recompile of everything we build, drop generated outputs + state, and
# (with --new-stellar) rotate to a brand-new funded Stellar address. The demo scripts already deploy
# fresh contracts on every run, so after this the next `stellar`/`base` is a from-scratch redeploy.
cmd_reset() {
  local rotate=0
  case "${2:-}" in --new-stellar|--rotate|--new-address) rotate=1 ;; esac
  printf '%s\n' "$(b '>>> reset — clean slate (recompile everything; fresh deploys on next run)')"

  printf '  cleaning build outputs to force a full recompile...\n'
  if have cargo; then
    ( cd "$ROOT/contracts/settlement" && cargo clean -p settlement >/dev/null 2>&1 ) || true
    ( cd "$ROOT/bridge-prover"        && cargo clean -p host -p bridge-methods >/dev/null 2>&1 ) || true
  fi
  have forge && ( cd "$EVM" && forge clean >/dev/null 2>&1 ) || true
  rm -rf "$ROOT"/circuits/*/target "$ROOT/bridge-prover/out" "$ROOT/artifacts"/* 2>/dev/null || true

  printf '  removing persisted driver state (.e2e)...\n'
  state_clear

  if [ "$rotate" = 1 ]; then
    if have stellar; then
      local id="e2e-$(date +%Y%m%d-%H%M%S)"
      printf '  generating + funding a FRESH Stellar identity (existing keys untouched): %s\n' "$id"
      stellar keys generate "$id" --network "$NETWORK" >/dev/null 2>&1 || true
      stellar keys fund     "$id" --network "$NETWORK" >/dev/null 2>&1 || true
      state_set DRIVER_IDENTITY "$id" >/dev/null 2>&1
      printf '  new Stellar address: %s\n' "$(stellar keys address "$id" 2>/dev/null)"
    else
      no "stellar CLI missing — cannot rotate identity"
    fi
  else
    printf '  (Stellar identity kept: %s — add --new-stellar for a brand-new address)\n' "$IDENTITY"
  fi

  printf '\nclean. Next (each recompiles + deploys fresh contracts):\n'
  printf '  %s stellar      # rebuild wasm, deploy a fresh Stellar contract + shield/place/match/unshield\n' "$0"
  printf '  %s base         # rebuild host/guest + EVM, deploy fresh Base + Stellar contracts\n' "$0"
  printf 'Committed proof fixtures are reused; regenerate only if circuits changed: %s regen (needs nargo+bb).\n' "$0"
}

cmd_help() { awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; }

case "${1:-status}" in
  status)  cmd_status ;;
  show)    cmd_show ;;
  stellar) cmd_stellar ;;
  base)    cmd_base ;;
  all)     cmd_all ;;
  summary) cmd_summary "$@" ;;
  regen)   cmd_regen ;;
  reset)   cmd_reset "$@" ;;
  clean)   cmd_clean ;;
  help|-h|--help) cmd_help ;;
  *) printf 'unknown command: %s\n\n' "$1"; cmd_help; exit 1 ;;
esac
