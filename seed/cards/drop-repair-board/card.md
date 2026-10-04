---
id: drop-repair-board
title: Delete repairBoardFromEvents
verify: bash scripts/seed/drop-repair-board.sh
---
# Delete repairBoardFromEvents

## Task
`src/loop.ts` exports `repairBoardFromEvents()` (the block under the comment `// ── EVENT-SOURCED REPLAY REPAIR (rebuild the board projection from events) ──`, around lines 517-544). Nothing in `src/` calls it. Delete:

1. The whole function and its section comment in `src/loop.ts`. If `renameSync` is then unused in the `node:fs` import of `src/loop.ts`, remove it from that import.
2. In `tests/v31.test.ts`: remove `repairBoardFromEvents` from the import line `import { parseCriticVerdict, runLoop, repairBoardFromEvents, cardsIn } from "../src/loop";` and delete the whole `describe("V3-1: event-sourced replay repair", ...)` block (it tests only the deleted function). This existing test file is not a check path; editing it is allowed and required, or `bun test` breaks.
3. Docs that describe the function as current behaviour: replace or drop the sentence in `docs/architecture.md` (line ~77) and `docs/appropriations.md` (line ~37). Not checked, but keep the docs honest.

The identifier `repairBoardFromEvents` must not appear anywhere under `src/`, comments included (the check greps `src/` for it). Do not rename it; delete it.

## Acceptance
- `grep -rn repairBoardFromEvents src/` finds nothing.
- `await import("src/loop.ts")` has no `repairBoardFromEvents` export.
- `src/loop.ts` still exports `runLoop`, `emit`, `readEvents`, `cardsIn`, `reopenCard`, `exitInProgress`, `parseCriticVerdict`.
- `bun test` (one test fewer: the deleted replay test) and `bunx tsc --noEmit` stay green.

## Context
Since Stage 0 the card's folder is the only truth for its column (kernel/card.ts); a replay that renames folders from the log contradicts that and has no caller.
The change is outside the kernel: `src/loop.ts`, `tests/v31.test.ts`, docs.
Do not edit tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
