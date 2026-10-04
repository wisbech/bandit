---
id: refiner-window
title: Refiner triggers on events since its last pass
verify: bun test ./tests/seed/refiner-window.check.ts
---
# Refiner triggers on events since its last pass

## Task
In `src/refiner.ts`, the private function `readEventsWindow(root)` returns every event ever logged (`readEvents(root)`). Both `shouldTrigger(root)` and `runRefinePass(...)` use it, so once the board has 3 `task.failed` events the refiner fires on every loop pass forever.

Change `readEventsWindow(root)` to:
1. Read `.bandit/refiner/history.jsonl` under `root` if it exists (one JSON object per line; skip blank or unparseable lines).
2. Find the LAST line whose `action` is `"refine"` and take its `ts` (an ISO string). Lines with any other action (for example `"rollback"`) are ignored.
3. Return `readEvents(root, ts)` (the kernel's `readEvents(root, sinceTs)` already returns only events with `ts > sinceTs`). With no refine entry, return `readEvents(root)` as today.

Do not change the thresholds in `shouldTrigger` (critic plumbing >= 2, container rejection >= 2, task failures >= 3) or `classifySignatures`. Do not change `appendHistory`; `runRefinePass` already appends `{ ts, action: "refine", ... }` at the end of every pass that runs.

## Acceptance
- No history file: 3 `task.failed` events make `shouldTrigger(root).trigger` true (unchanged).
- After a pass (`runRefinePass(root, async () => "[]")` that ran), the same 3 failures no longer trigger; 2 new failures do not; a 3rd new failure does, and the reason mentions 3.
- A second non-forced `runRefinePass` right after a pass returns `ran: false`.
- Two `critic.repair` events before a pass do not count after it; one new `critic.repair` does not trigger; one more plumbing event (`critic.bypass`) does.
- The window starts at the last `"refine"` entry; a later `"rollback"` entry does not move it.
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
The refiner counted all-time events (docs/plans/seed.md, "What the code does today that breaks the rules"), so a past burst of failures kept it firing.
The change is outside the kernel: `src/refiner.ts` only.
Do not edit tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
