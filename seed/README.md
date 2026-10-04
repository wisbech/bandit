# Seed backlog, Stage 1: cards and checks

Ten cards for the loop to build, each judged by a check the worker cannot edit. A human wrote every check
first (rule 5); each is red on the tree these cards were cut from (`seed/stage1`, `21c5850`) and goes green
only when the behaviour exists. Before committing, every check was also run green against a throwaway
implementation, so none of them asks for the impossible. That code was not kept.

Cards: `seed/cards/<id>/card.md`, in the board's format (`id`, `title`, `verify` frontmatter; `## Task`,
`## Acceptance`, `## Context`). Checks: `tests/seed/<id>.check.ts`, plus `scripts/seed/<id>.sh` where the
requirement is that something is gone.

## Cards

| id | goal | verify (exact argv) | check paths |
|---|---|---|---|
| `idle-timeout` | Headless idle watchdog becomes one timeout reset by each stream event; `TransportConfig.idleTimeoutMs`; no `setInterval` in `src/runner.ts` | `bash scripts/seed/idle-timeout.sh` | `tests/seed/idle-timeout.check.ts,scripts/seed/idle-timeout.sh` |
| `no-heartbeat` | Delete the 60 s heartbeat; the persistent loop holds no interval and still wakes on board events | `bash scripts/seed/no-heartbeat.sh` | `tests/seed/no-heartbeat.check.ts,scripts/seed/no-heartbeat.sh` |
| `drop-repair-board` | Delete the caller-less `repairBoardFromEvents` | `bash scripts/seed/drop-repair-board.sh` | `tests/seed/drop-repair-board.check.ts,scripts/seed/drop-repair-board.sh` |
| `refiner-window` | `shouldTrigger` counts only events after the last `refine` history entry | `bun test ./tests/seed/refiner-window.check.ts` | `tests/seed/refiner-window.check.ts` |
| `prompts-tracked` | `prompts/<serf>/prompt.md` wins over `.bandit/serfs/<serf>/prompt.md`; `bandit prompts export [--force]` | `bun test ./tests/seed/prompts-tracked.check.ts` | `tests/seed/prompts-tracked.check.ts` |
| `refiner-proposals` | `"refiner": "propose"`: no serf edit, a `proposal-*` backlog card per edit, `refiner.proposed` events | `bun test ./tests/seed/refiner-proposals.check.ts` | `tests/seed/refiner-proposals.check.ts` |
| `failure-draft` | A card sent to review writes `.bandit/drafts/<id>-retry/card.md` and logs `card.drafted`; drafts are never claimed | `bun test ./tests/seed/failure-draft.check.ts` | `tests/seed/failure-draft.check.ts` |
| `cost-report` | `bandit cost [--json]`: rounds, tokens, judge acceptance per card; tokens per accepted card | `bun test ./tests/seed/cost-report.check.ts` | `tests/seed/cost-report.check.ts` |
| `bench` | `bandit bench <board-dir> [--json]`: frozen board in a temp git project, judged, one JSON line out, temp removed | `bun test ./tests/seed/bench.check.ts` | `tests/seed/bench.check.ts` |
| `keep-rule` | `keepDecision(pairs, total?)` in `src/keep-rule.ts`: paired sign test, abort at -2, keep at +5, token tie-break | `bun test ./tests/seed/keep-rule.check.ts` | `tests/seed/keep-rule.check.ts` |
| `folder-router` | `routeCard`/`routeCandidates` in `src/router.ts`: serf folders and their `## Mission` are the routing table, picked by the port's Choice; `"router": "folders"` makes the loop run the routed folder as the actor | `bun test ./tests/seed/folder-router.check.ts` | `tests/seed/folder-router.check.ts` |

No card touches the kernel. Each starts from the base tree alone and can be done in any order.

## Why the checks do not run in `bun test`

The judge runs the whole suite as a project gate (`bandit.json`: `bun test --timeout 30000`). Ten red seed
tests in it would fail every other card's gate. So the checks are named `*.check.ts`: bun's default test
glob only takes `*.test.*`, `*_test_*`, `*.spec.*` and `*_spec_*`, and skips them. A path that starts with
`./` is run regardless of its name, so `bun test ./tests/seed/<id>.check.ts` runs exactly one check.
**The `./` is load-bearing**: `bun test tests/seed/<id>.check.ts` without it is a name filter, matches no
test file, and bun exits non-zero for another reason. Verified on bun 1.4.2.

`bunx tsc --noEmit` still type-checks the checks (`tests/**/*.ts`), and they pass it on the base tree:
code that does not exist yet is reached through `await import(<path>)` typed `any`, or through the CLI.

Consequence: once a card is accepted, its check stays outside the default suite, so a later card can
regress it without failing a gate. Promote an accepted check into the suite (rename it to `.test.ts`)
in a human commit, or add a gate that runs `bun test ./tests/seed/` explicitly once all ten are green.

## Ratify

For each card, copy `seed/cards/<id>/` onto the board (`.bandit/board/backlog/<id>/`), then from the repo
root, with the check files committed on the base branch:

```sh
bandit ratify idle-timeout      --paths tests/seed/idle-timeout.check.ts,scripts/seed/idle-timeout.sh
bandit ratify no-heartbeat      --paths tests/seed/no-heartbeat.check.ts,scripts/seed/no-heartbeat.sh
bandit ratify drop-repair-board --paths tests/seed/drop-repair-board.check.ts,scripts/seed/drop-repair-board.sh
bandit ratify refiner-window    --paths tests/seed/refiner-window.check.ts
bandit ratify prompts-tracked   --paths tests/seed/prompts-tracked.check.ts
bandit ratify refiner-proposals --paths tests/seed/refiner-proposals.check.ts
bandit ratify failure-draft     --paths tests/seed/failure-draft.check.ts
bandit ratify cost-report       --paths tests/seed/cost-report.check.ts
bandit ratify bench             --paths tests/seed/bench.check.ts
bandit ratify keep-rule         --paths tests/seed/keep-rule.check.ts
bandit ratify folder-router     --paths tests/seed/folder-router.check.ts
```

`ratify` takes the verify argv from the card's `verify:` line and writes `checks/<id>.json` with the
sha256 of each path. Commit `checks/` on the base branch; that commit is the ratification. A dry run of
`ratify` on two of these cards produced the expected `checks/<id>.json` (verify argv, both paths, hashes).

## Red-proof (base tree `21c5850`, bun 1.4.2)

One line per card: the verify argv, and the first failing assertion observed.

- `idle-timeout`: `bash scripts/seed/idle-timeout.sh` exits 1 at the grep: `src/runner.ts:240: const idleWatch = setInterval(...)`. The behaviour check alone, `bun test ./tests/seed/idle-timeout.check.ts`: 3 of 5 fail; first, "a worker that goes silent is killed within the idle limit": `expect(r.stalled).toBe(true)`, received `false` after 8017 ms (the run timeout killed it, not the idle limit).
- `no-heartbeat`: `bash scripts/seed/no-heartbeat.sh` exits 1 at the grep: `src/loop.ts:1016: const heartbeat = setInterval(...)`. The behaviour check alone: `expect(r.intervalsWhileHolding).toEqual([])`, received `[60000]`.
- `drop-repair-board`: `bash scripts/seed/drop-repair-board.sh` exits 1 at the grep: `src/loop.ts:519: export function repairBoardFromEvents()`. The behaviour check alone: `expect("repairBoardFromEvents" in loop).toBe(false)`, received `true`.
- `refiner-window`: 4 of 5 fail; first, "failures counted before the last pass do not re-trigger": `expect(shouldTrigger(root).trigger).toBe(false)` after a pass, received `true`.
- `prompts-tracked`: 6 of 6 fail; first, `readSerfFolder(dir, root).prompt` expected `"FROM-TRACKED actor: {{card.task}}\n"`, received `"FROM-BANDIT actor: ..."`; `bandit prompts export` exits 1 (unknown command), expected 0.
- `refiner-proposals`: 2 of 3 fail; first, the `.bandit/serfs` tree hash changed in propose mode (the edits were applied).
- `failure-draft`: 2 of 3 fail; first, `existsSync(.bandit/drafts/widget-retry/card.md)` expected `true`, received `false`.
- `cost-report`: 4 of 4 fail; first, `bandit cost --json` exit code expected 0, received 1 (`unknown command: cost`).
- `bench`: 2 of 2 fail; first, `bench exited 1` (`unknown command: bench`); a missing board dir exits 1, expected 2.
- `keep-rule`: 20 of 20 fail; first, `existsSync(src/keep-rule.ts)` expected `true`, received `false`.
- `folder-router` (added later, on `seed/stage1` `1439b08`): 21 of 22 fail; first, `existsSync(src/router.ts)` expected `true`, received `false`; the loop wiring check finds only `ACTOR-PROMPT-MARKER` in the worker's prompts, expected `TESTER-PROMPT-MARKER`. The one that passes is the default-config guard (no `router` key: actor prompt, no `card.routed`), which must stay green. Green against a throwaway `src/router.ts` plus the `convergeCard` hook, 3 runs of 3; that code was not kept.

Default suite on the same commit with these files added: `bun test` 178 pass, 1 skip, 0 fail;
`bunx tsc --noEmit` clean.

## Notes for whoever runs Stage 1

- The judge rejects a diff that touches this card's own check paths, but not another card's. Add
  `tests/seed/` and `scripts/seed/` to `protected` in `bandit.json` (a human, kernel-owned change) so no
  card can touch any seed check.
- `drop-repair-board` must edit `tests/v31.test.ts` (it imports the deleted function). That file is not a
  check path; the card says so.
- `idle-timeout` and `no-heartbeat` measure wall time. Margins are wide (event gaps of 300 ms against a
  1000 to 1500 ms limit, upper bounds 2.5x to 4x the limit); the idle-timeout check ran green 8 times in a
  row against the throwaway implementation on a loaded machine.
- `keep-rule` judges keep only once all pairs are in; only the abort is early. That reads the plan's "abort
  and revert as soon as" as applying to abort alone. If keep should also stop early, change the check's
  "keep is judged only when all pairs are in" row before ratifying.
