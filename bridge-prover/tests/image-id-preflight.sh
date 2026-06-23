#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/../scripts/lib/bridge_image_id.sh"

PIN=$(bridge_image_id_read_pin "$ROOT/image-id.hex")
bridge_image_id_check "$PIN" "$PIN" "$ROOT/image-id.hex"

BAD=$(printf '00%.0s' {1..32})
OUT=$(mktemp "${TMPDIR:-/tmp}/mosaic-image-id.XXXXXX")
trap 'rm -f "$OUT"' EXIT
if bridge_image_id_check "$PIN" "$BAD" "$ROOT/image-id.hex" >"$OUT" 2>&1; then
  echo "image-id preflight test failed: mismatch was accepted" >&2
  exit 1
fi
grep -q "pinned: $PIN" "$OUT"
grep -q "built:  $BAD" "$OUT"
grep -q "run-host --force-rebuild -- --print-image-id" "$OUT"
grep -q "After review:" "$OUT"

echo "image-id preflight tests passed"
