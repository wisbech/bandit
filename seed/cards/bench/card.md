---
id: bench
title: bandit bench - run a frozen board in a temp project
verify: bun test ./tests/seed/bench.check.ts
---
# bandit bench - run a frozen board in a temp project

## Task
1. New file `src/bench.ts` exporting `runBench(home: string, boardDir: string): Promise<BenchReport>` where
   `BenchReport = { cards: number; accepted: number; rounds: number; tokens: number; costPerAccepted: number | null; results: { id: string; accepted: boolean; rounds: number; tokens: number }[] }`.
   Steps:
   - `boardDir` is a directory of card folders (`<boardDir>/<id>/card.md`). The cards are the subfolders that contain `card.md`.
   - Make a temp project: `mkdtempSync(join(tmpdir(), "bandit-bench-"))` (`tmpdir` from `node:os`, so `TMPDIR` is honoured). In it run `git init -q -b main`, write `.gitignore` containing `.bandit/`, `git add .gitignore`, and `git -c user.name=bandit -c user.email=bandit@localhost commit -q -m bench` (one commit; use `Bun.spawnSync` or `defaultExec` from `src/runner.ts`).
   - Create `.bandit/board/{backlog,in-progress,review,done}` and `.bandit/events`; copy every card folder into `.bandit/board/backlog/` (`cpSync(..., { recursive: true })`); copy `<home>/.bandit/serfs/` to `.bandit/serfs/`; copy `<home>/.bandit/harnesses/` too when it exists.
   - Write the temp `.bandit/config.json` as `{ transport, command, args, maxRetries }` taken from `<home>/.bandit/config.json`, plus `"isolation": "worktree"` so every converged card is judged. Do not copy other keys (gates from the home project would run in an empty project).
   - The loop resolves paths from `process.cwd()`: `process.chdir(temp)`, then `await runLoop({ root: temp, transport: resolveTransport({ kind: cfg.transport ?? "headless", command: cfg.command ?? "opencode", args: cfg.args ?? ["run"] }, temp), maxRetries: cfg.maxRetries ?? 3, once: true })`, and always `process.chdir(home)` afterwards (in `finally`).
   - Per card, from the temp project: `rounds` = number of `round.started` events for it (kernel `readEvents(temp)`); `accepted` = its latest `acceptance.passed`/`acceptance.failed` event is `acceptance.passed`; `tokens` = `lifetimeTokensUsed` in its `card.md` frontmatter wherever it ended (`findCardDir`, `parseCard`), 0 if absent. Totals as sums; `costPerAccepted = tokens / accepted`, `null` when 0. `results` sorted by id.
   - Remove the temp project in `finally` (`rmSync(temp, { recursive: true, force: true })`), also when the loop throws.
   This card must not depend on any other seed card's code (for example a cost module): compute the report here.
2. In `src/cli.ts`, add a `COMMANDS` entry `name: "bench"`, usage `bandit bench <board-dir> [--json]`, home = `process.cwd()`.
   - Missing argument, or `<board-dir>` not an existing directory: usage on stderr, `process.exit(2)`.
   - Print `JSON.stringify(report)` on ONE line as the last line of stdout (with or without `--json`; loop chatter may come before it). Exit 0.

## Acceptance
- A 3-card frozen board (`verify: true`, `verify: true`, `verify: false`), a home project whose config names a stub worker and `maxRetries: 2`: the JSON has `cards 3`, `accepted 2`; the two passing cards `accepted: true, rounds: 1`; the failing card `accepted: false, rounds: 2`; every card `tokens > 0`; `tokens` is the sum of the cards' tokens, `rounds` is 4, `costPerAccepted` is tokens / 2.
- The frozen board directory is byte-identical afterwards; the home project gains no files or folders, its board stays empty, and its log has no `round.started`.
- Nothing is left in `TMPDIR` that contains `.bandit` or `.git`.
- A missing board directory exits 2.
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
The plan scores bandit by cost per judge-accepted card on a frozen benchmark board (docs/plans/seed.md, Score); bench is the instrument.
The change is outside the kernel: new `src/bench.ts`, `src/cli.ts`. The judge runs inside the temp project through the existing isolation path.
Do not edit tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
