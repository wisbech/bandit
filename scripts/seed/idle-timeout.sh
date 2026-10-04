#!/usr/bin/env bash
# Seed check: idle-timeout. Human-owned; a candidate that edits this file is rejected by the judge.
# No setInterval may remain in src/runner.ts (comments included), then the behaviour check.
set -euo pipefail
cd "$(dirname "$0")/../.."
if grep -n "setInterval" src/runner.ts; then
  echo "FAIL: setInterval still in src/runner.ts (liveness must be one timeout reset by each stream event)" >&2
  exit 1
fi
exec bun test ./tests/seed/idle-timeout.check.ts
