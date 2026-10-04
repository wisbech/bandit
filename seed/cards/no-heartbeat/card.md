---
id: no-heartbeat
title: Remove the persistent loop's heartbeat interval
verify: bash scripts/seed/no-heartbeat.sh
---
# Remove the persistent loop's heartbeat interval

## Task
In `src/loop.ts`, function `runLoop`, the persistent branch `if (!config.once) { ... }` (around lines 1011-1050) starts `const heartbeat = setInterval(() => { console.log("  ◌ ... watching… (board empty)") }, 60_000);`. Delete that interval and its comment line ("visible liveness: one heartbeat per minute ..."). Nothing replaces it.

Keep everything else in that branch exactly as it works today:
- the one-time `console.log("  ◌ board drained — watching for new cards ...")` line,
- `fs.watch` on `.bandit/board/backlog` and `.bandit/board/in-progress`,
- the 500 ms debounce `setTimeout` in `onBoardEvent` (a debounce on an event is not polling),
- the `wake` function that re-runs `runLoop({ ...config, once: true })`,
- the hold `await new Promise<void>(() => {})` so `runLoop` with `once: false` never resolves.

The word `setInterval` must not appear anywhere in `src/loop.ts`, comments included (the check greps for it).

## Acceptance
- `grep setInterval src/loop.ts` finds nothing.
- `runLoop({ root, transport, once: false })` on an empty board calls `setInterval` zero times (the check wraps `globalThis.setInterval` in a child process and counts calls).
- After 1.5 s the call has neither resolved nor thrown: the loop still holds.
- A card folder written into `.bandit/board/backlog/` while the loop holds leaves backlog within 8 s: the watcher still wakes the loop.
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
The plan's "no polling" rule: the persistent loop waits on board events; it holds no timers of its own.
The change is outside the kernel: `src/loop.ts` only.
Do not edit tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
