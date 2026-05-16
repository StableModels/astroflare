#!/usr/bin/env bash
# Flake-rate probe for the upstream workerd teardown crash
# (cloudflare/workerd#6506). Validation harness for the pool-split +
# fail-closed guard; not run in CI.
#
# Usage:
#   scripts/flake-probe.sh [N]            # post-split: node + guarded workerd
#   MODE=combined scripts/flake-probe.sh [N]   # legacy single combined run
#
# Records, per iteration: exit codes and whether the run carried the
# teardown signature vs a real test-failure summary. A healthy post-fix
# result is all-green node + all-green guarded workerd over N>=10.
set -u
N="${1:-10}"
MODE="${MODE:-split}"
SIG="Fatal uncaught kj::Exception: workerd/jsg/setup.c++"
FAIL='Test Files .* failed|⎯ Failed Tests ⎯| FAIL '

if [ "$MODE" = "combined" ]; then
  echo "run,exit,teardown_sig,real_failure"
  for i in $(seq 1 "$N"); do
    log="/tmp/flake-combined-$i.log"
    pnpm exec vitest run \
      --project core --project compiler --project runtime --project preview \
      --project build --project test-utils --project content --project cli \
      --project cli-lib --project host-cloudflare --project starter \
      --project workerd --project repo --project conformance \
      --project minimal-blog > "$log" 2>&1
    ec=$?
    s=0; grep -q "$SIG" "$log" && s=1
    f=0; grep -qE "$FAIL" "$log" && f=1
    echo "$i,$ec,$s,$f"
  done
else
  echo "run,node_exit,workerd_exit,workerd_teardown_sig,workerd_real_failure"
  for i in $(seq 1 "$N"); do
    pnpm test:node    > "/tmp/flake-node-$i.log"    2>&1; ne=$?
    pnpm test:workerd > "/tmp/flake-workerd-$i.log" 2>&1; we=$?
    s=0; grep -q "$SIG" "/tmp/flake-workerd-$i.log" && s=1
    f=0; grep -qE "$FAIL" "/tmp/flake-workerd-$i.log" && f=1
    echo "$i,$ne,$we,$s,$f"
  done
fi
