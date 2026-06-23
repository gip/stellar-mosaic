#!/usr/bin/env bash
# Shared persistence for the e2e driver (scripts/e2e.sh) and the demo scripts (04, 10).
#
# State lives in $E2E_STATE_DIR (default <repo>/.e2e, gitignored) as simple KEY=VALUE lines in
# state.env. Sourcing this file only DEFINES functions — it writes nothing until state_set is called,
# so the demo scripts stay runnable standalone (a direct run just records its outputs as a bonus).
#
# Usage:
#   source "<repo>/scripts/lib/e2e_state.sh"
#   state_set SETTLEMENT_CID "$CID"
#   cid=$(state_get SETTLEMENT_CID)

# Resolve the repo root from this file's location (scripts/lib/ -> repo).
E2E_REPO="${E2E_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
E2E_STATE_DIR="${E2E_STATE_DIR:-$E2E_REPO/.e2e}"
E2E_STATE_FILE="${E2E_STATE_FILE:-$E2E_STATE_DIR/state.env}"

# state_set KEY VALUE — upsert a key (last write wins), keep the file sorted. Notice goes to stderr so
# it never pollutes a value captured via $(...).
state_set() {
  local key="$1" val="$2" tmp
  mkdir -p "$E2E_STATE_DIR"
  touch "$E2E_STATE_FILE"
  tmp="$(mktemp)"
  grep -v "^${key}=" "$E2E_STATE_FILE" 2>/dev/null > "$tmp" || true
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  sort -o "$tmp" "$tmp"
  mv "$tmp" "$E2E_STATE_FILE"
  printf '    [state] %s=%s\n' "$key" "$val" >&2
}

# state_get KEY — print the value (empty if unset).
state_get() {
  [ -f "$E2E_STATE_FILE" ] || return 0
  sed -n "s/^$1=//p" "$E2E_STATE_FILE" | tail -1
}

# state_has KEY — succeed iff the key is set and non-empty.
state_has() { [ -n "$(state_get "$1")" ]; }

# state_dump — print the whole state file (empty if none).
state_dump() { [ -f "$E2E_STATE_FILE" ] && cat "$E2E_STATE_FILE" || true; }

# state_clear — remove all persisted state (does NOT touch committed fixtures).
state_clear() { rm -rf "$E2E_STATE_DIR"; }

# -------------------------------------------------------------------------------------------------
# Per-stage run log + tables.
#
# A run is a sequence of stages; each stage holds (field, value) rows. Rows are appended to a TSV
# (leg, stage, field, value) so the end-of-run summary can re-render every table in one place. Box
# rendering is shared between the live per-stage table and the summary.
#
#   run_begin "Stellar"           # start a leg (clears that leg's old rows; keeps the other leg's)
#   stage "deploy"                # open a stage
#   note "settlement" "$CID"      # record + accumulate a row
#   endstage                      # print this stage as a table
#   ... more stages ...
#   print_summary "$E2E_LEG"      # re-print all of this leg's tables (omit arg for ALL legs)
E2E_RUNLOG="${E2E_RUNLOG:-$E2E_STATE_DIR/runlog.tsv}"
E2E_LEG="${E2E_LEG:-}"
E2E_STAGE="${E2E_STAGE:-}"

# run_begin LEG — open a leg's section, dropping any previous rows for the SAME leg (so a re-run
# replaces its tables rather than duplicating them) while preserving the other leg's rows.
run_begin() {
  E2E_LEG="$1"
  mkdir -p "$E2E_STATE_DIR"; touch "$E2E_RUNLOG"
  local tmp; tmp="$(mktemp)"
  awk -F'\t' -v leg="$1" '$1!=leg' "$E2E_RUNLOG" > "$tmp" 2>/dev/null || true
  mv "$tmp" "$E2E_RUNLOG"
}

# stage NAME — open a new stage under the current leg.
stage() { E2E_STAGE="$1"; }

# note FIELD VALUE — append a row to the run log for the current leg+stage.
note() { printf '%s\t%s\t%s\t%s\n' "${E2E_LEG:-?}" "${E2E_STAGE:-?}" "$1" "$2" >> "$E2E_RUNLOG"; }

# _render [LEG] [STAGE] — print rows from the run log as boxed tables, grouped by leg+stage. Empty
# filters match everything.
_render() {
  local fleg="${1:-}" fstage="${2:-}"
  [ -s "$E2E_RUNLOG" ] || { printf '  (nothing recorded)\n'; return 0; }
  awk -F'\t' -v fleg="$fleg" -v fstage="$fstage" '
    function bar(){ printf "  └"; for(i=0;i<54;i++) printf "─"; printf "\n" }
    (fleg=="" || $1==fleg) && (fstage=="" || $2==fstage) {
      key=$1" · "$2
      if(key!=cur){ if(cur!="") bar(); cur=key; printf "\n  ┌─ %s\n", key }
      printf "  │ %-22s %s\n", $3, $4
    }
    END{ if(cur!="") bar() }
  ' "$E2E_RUNLOG"
}

# endstage — print the current stage as a table (live, during the run).
endstage() { _render "$E2E_LEG" "$E2E_STAGE"; }

# print_summary [LEG] — re-print every table (optionally filtered to one leg) under a banner.
print_summary() {
  printf '\n%s\n' "════════════════════════ E2E SUMMARY ════════════════════════"
  _render "${1:-}"
  printf '\n'
}
