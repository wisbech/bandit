---
id: idle-timeout
title: Idle watchdog becomes a resettable timeout
verify: bash scripts/seed/idle-timeout.sh
---
# Idle watchdog becomes a resettable timeout

## Task
In `src/runner.ts`, function `runTransport`, the `cfg.kind === "headless"` branch (around lines 223-281) watches the worker with `const idleWatch = setInterval(..., 10_000)`. Replace it with timeouts:

1. Add an optional field to `export interface TransportConfig`: `idleTimeoutMs?: number;` (the idle limit in ms; when absent use `300_000`, today's `eventIdleLimit`).
2. Start one idle timer with `setTimeout` right after the process is spawned. In the stdout reader loop, where each non-empty line is handled (today `lastEventAt = Date.now();`), reset it: `clearTimeout(idle); idle = setTimeout(onIdle, limit);`.
3. When the idle timer fires: kill the process (`proc.kill()` inside try/catch) and resolve the promise with `stalled: true` (exitCode -1), exactly as `finish(true)` does today.
4. When the run timeout (the `timeoutMs` argument) fires: kill the process and resolve with `stalled: true` too. Today a separate `timer` kills the process and the result comes back with `stalled: false`; fix that.
5. Clear both timers when the process exits or the promise settles. Remove `idleWatch`, `lastEventAt` and the `clearInterval` calls.
6. The word `setInterval` must not appear anywhere in `src/runner.ts`, comments included (the check greps for it).

Public surface the check uses: `runTransport(cfg, prompt, cwd, outputPath, timeoutMs): Promise<RunResult>` with `cfg = { kind: "headless", command: <script>, args: [], idleTimeoutMs?: number }`. `RunResult.stalled` is `true` and `RunResult.ok` is `false` when the worker was killed for idling or for the run timeout; otherwise `stalled` is false or absent and `exitCode` is the process's exit code.

## Acceptance
- `grep setInterval src/runner.ts` finds nothing.
- A worker printing a line every 300 ms for 2.4 s with `idleTimeoutMs: 1500` is not killed: `stalled` false, `exitCode` 0, output contains every tick.
- A worker that prints one line and then sleeps, with `idleTimeoutMs: 1000`, returns `stalled: true`, `ok: false` after at least 900 ms and in under 4 s.
- A worker printing a line every 300 ms for 3 s and then going silent, with `idleTimeoutMs: 1000`, survives the 3 s and is then killed: `stalled: true`, total under 6.5 s.
- A worker that never stops printing, with `idleTimeoutMs: 5000` and run timeout 1500 ms, returns `stalled: true` in under 4.5 s.
- With no `idleTimeoutMs`, a 1.5 s silence is not a stall.
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
The 10 s polling interval cannot kill a hung worker sooner than 10 s and is polling the plan rules out ("no polling": liveness is the time since the last stream event).
The fix is outside the kernel: `src/runner.ts` only.
Do not edit tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
