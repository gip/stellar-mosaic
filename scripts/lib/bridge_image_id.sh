#!/usr/bin/env bash

# Read a reviewed RISC Zero guest image-ID pin. The file must contain exactly one lowercase,
# 64-character hex digest (surrounding whitespace is ignored).
bridge_image_id_read_pin() {
  local pin_file="$1" value
  [ -f "$pin_file" ] || { echo "ERROR: guest image ID pin not found: $pin_file" >&2; return 1; }
  value=$(tr -d '[:space:]' < "$pin_file")
  if ! [[ "$value" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: guest image ID pin must be exactly 64 lowercase hex characters: $pin_file" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

# Fail before deploying or proving when the reviewed pin and the host's embedded guest disagree.
bridge_image_id_check() {
  local expected="$1" actual="$2" pin_file="$3"
  if ! [[ "$actual" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: bridge host returned an invalid guest image ID: $actual" >&2
    return 1
  fi
  if [ "$expected" != "$actual" ]; then
    echo "ERROR: bridge guest image ID does not match the reviewed pin" >&2
    echo "  pinned: $expected" >&2
    echo "  built:  $actual" >&2
    echo "First rule out stale build artifacts:" >&2
    echo "  $(dirname "$pin_file")/run-host --force-rebuild -- --print-image-id" >&2
    echo "Review the guest source, dependencies, and toolchain before rotating the pin." >&2
    echo "After review: printf '%s\\n' '$actual' > '$pin_file'" >&2
    return 1
  fi
}
