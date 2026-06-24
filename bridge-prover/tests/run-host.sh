#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/mosaic-run-host.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

WORK="$TMP/bridge-prover"
mkdir -p "$WORK"
cp "$ROOT/run-host" "$ROOT/Cargo.toml" "$ROOT/Cargo.lock" "$ROOT/rust-toolchain.toml" "$WORK/"
cp -R "$ROOT/host" "$ROOT/methods" "$WORK/"

export CARGO="$ROOT/tests/fixtures/fake-cargo"
export CARGO_TARGET_DIR="$TMP/target"
export BUILD_LOG="$TMP/build.log"
export HOST_LOG="$TMP/host.log"
export FAKE_HOST_TEMPLATE="$ROOT/tests/fixtures/fake-host"
export FAKE_BUILD_DELAY=0
touch "$BUILD_LOG" "$HOST_LOG"

fail() {
  echo "run-host test failed: $*" >&2
  exit 1
}

assert_builds() {
  local expected="$1" actual
  actual="$(wc -l < "$BUILD_LOG" | tr -d ' ')"
  [ "$actual" = "$expected" ] || fail "expected $expected builds, got $actual"
}

assert_host_runs() {
  local expected="$1" actual
  actual="$(grep -c '^env:' "$HOST_LOG" || true)"
  [ "$actual" = "$expected" ] || fail "expected $expected host runs, got $actual"
}

append_comment() {
  printf '\n# launcher invalidation test\n' >> "$1"
}

# A missing binary builds once, then exec preserves environment, arguments, and exit status.
set +e
FORWARDED_ENV=preserved HOST_EXIT=7 "$WORK/run-host" -- --alpha "two words"
status=$?
set -e
[ "$status" -eq 7 ] || fail "expected host exit 7, got $status"
assert_builds 1
assert_host_runs 1
grep -q '^env:preserved$' "$HOST_LOG" || fail "environment was not forwarded"
grep -q '^arg:two words$' "$HOST_LOG" || fail "argument boundaries were not preserved"

# An unchanged invocation bypasses fake Cargo.
HOST_EXIT=0 "$WORK/run-host" -- --alpha unchanged
assert_builds 1
assert_host_runs 2

# Source content invalidates even when its mtime is made much older than the binary.
append_comment "$WORK/host/src/main.rs"
touch -t 200001010000 "$WORK/host/src/main.rs"
"$WORK/run-host" -- --host-change
assert_builds 2

append_comment "$WORK/methods/guest/src/main.rs"
"$WORK/run-host" -- --guest-change
assert_builds 3

# Manifests, lockfiles, toolchain/Cargo configuration, tool versions, and build environment count.
append_comment "$WORK/Cargo.toml"
"$WORK/run-host" -- --manifest-change
assert_builds 4

append_comment "$WORK/methods/guest/Cargo.lock"
"$WORK/run-host" -- --lock-change
assert_builds 5

mkdir -p "$WORK/.cargo"
printf '[build]\nincremental = false\n' > "$WORK/.cargo/config.toml"
"$WORK/run-host" -- --config-change
assert_builds 6

export FAKE_CARGO_VERSION=test-2
"$WORK/run-host" -- --tool-change
assert_builds 7

RUSTFLAGS='-C debuginfo=0' "$WORK/run-host" -- --environment-change
assert_builds 8

# Force always rebuilds even with otherwise unchanged inputs.
"$WORK/run-host" --force-rebuild -- --forced
assert_builds 9

# A failed rebuild does not execute the old host or publish a new cache stamp.
append_comment "$WORK/methods/build.rs"
before_runs="$(grep -c '^env:' "$HOST_LOG" || true)"
set +e
FAIL_BUILD=1 "$WORK/run-host" -- --must-not-run
status=$?
set -e
[ "$status" -eq 42 ] || fail "expected failed build exit 42, got $status"
assert_builds 10
assert_host_runs "$before_runs"

# Because the failed build was not stamped, the next invocation retries and succeeds.
"$WORK/run-host" -- --retry
assert_builds 11

# Concurrent misses serialize; the waiter rechecks the stamp instead of starting a second build.
append_comment "$WORK/methods/src/lib.rs"
export FAKE_BUILD_DELAY=0.5
"$WORK/run-host" -- --concurrent-one &
pid_one=$!
"$WORK/run-host" -- --concurrent-two &
pid_two=$!
wait "$pid_one"
wait "$pid_two"
assert_builds 12

echo "run-host tests passed"
