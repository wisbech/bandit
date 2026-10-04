#!/usr/bin/env bash
# Seed check: no-heartbeat. Human-owned; a candidate that edits this file is rejected by the judge.
# No setInterval may remain in src/loop.ts (comments included), then the behaviour check.
set -euo pipefail
cd "$(dirname "$0")/../.."
if grep -n "setInterval" src/loop.ts; then
  echo "FAIL: setInterval still in src/loop.ts (the persistent loop holds no timers of its own)" >&2
  exit 1
fi
exec bun test ./tests/seed/no-heartbeat.check.ts
