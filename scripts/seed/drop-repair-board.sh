#!/usr/bin/env bash
# Seed check: drop-repair-board. Human-owned; a candidate that edits this file is rejected by the judge.
# The identifier repairBoardFromEvents must be gone from src/ (comments included), then the behaviour check.
set -euo pipefail
cd "$(dirname "$0")/../.."
if grep -rn "repairBoardFromEvents" src/; then
  echo "FAIL: repairBoardFromEvents still appears in src/" >&2
  exit 1
fi
exec bun test ./tests/seed/drop-repair-board.check.ts
