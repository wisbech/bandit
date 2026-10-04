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
| `measures` | `readMeasures`/`progressSince` in `src/measures.ts`, `bandit measures [--json]`: cost per accepted card, `.ts` lines under `src/`, ratified checks whose card passed, lines per check; `measure.read` event; change between the last two reads | `bun test ./tests/seed/measures.check.ts` | `tests/seed/measures.check.ts` |
| `progress-order` | `leverProgress`/`orderFrontier`/`leverHistory` in `src/progress.ts`; `"order": "progress"` claims the backlog by lever progress (falling cost first, then unexplored, then known-flat) and parks levers flat 3 times (`card.parked`) | `bun test ./tests/seed/progress-order.check.ts` | `tests/seed/progress-order.check.ts` |
| `shrink-check` | `shrinkReport` in `src/shrink.ts`, `bandit shrink-check [--base <ref>] [--path <dir>] [--json]`: exit 0 only when `git diff --numstat <base>...HEAD -- <path>` is net negative | `bun test ./tests/seed/shrink-check.check.ts` | `tests/seed/shrink-check.check.ts` |
| `port-guard` | `protectedList`/`guard` in `src/port.ts`, `bandit guard [--json] [--repo <dir>] <path>...`: kernel list + `bandit.json` `protected` + ratified check paths; exit 0 allowed, 1 hit, 2 usage; read-only | `bun test ./tests/seed/port-guard.check.ts` | `tests/seed/port-guard.check.ts` |
| `port-status` | `status` in `src/port-status.ts`, `bandit status [--json]`: columns, per-card verify/ratified/verdict (judge events only)/claimedBy, `lastEventTs`; read-only | `bun test ./tests/seed/port-status.check.ts` | `tests/seed/port-status.check.ts` |
| `port-work` | `src/port-work.ts`, `bandit next` / `submit` / `release`: any harness claims a card (kernel `claimCard` + `openWorktree`, a `port.next` lease), hands back a change judged by the kernel `acceptRef`; the loop leaves a leased card alone | `bun test ./tests/seed/port-work.check.ts` | `tests/seed/port-work.check.ts` |
| `adapters` | `adapters/`: the one-page port contract, a git pre-commit hook, a Claude Code mod (`tool.call` guard), a GitHub Actions accept template; glue that only calls the port | `bun test ./tests/seed/adapters.check.ts` | `tests/seed/adapters.check.ts` |

No card touches the kernel. Each starts from the base tree alone and can be done in any order.
The last three (the progress cards) were cut from `seed/kept-opus` `a8a4ebf`, not `21c5850`.
The four port cards (`port-guard`, `port-status`, `port-work`, `adapters`) were cut from `seed/kept-opus` `d09f5e4`.
They create separate files (`src/port.ts`, `src/port-status.ts`, `src/port-work.ts`, `adapters/`) so that
keeping them in any order conflicts only in `src/cli.ts`'s `COMMANDS` table. `port-work` keeps its own copy of the
protected list (`portProtected`) rather than importing `port-guard`'s; a later deletion card can merge the two.

## Deletion cards

A deletion card is an ordinary card whose `verify:` asks for a net line drop, for example

```
verify: bun src/shrink.ts --base main
```

(once `shrink-check` is accepted; `bun src/cli.ts shrink-check --base main` is the same verb). The judge runs
that argv and the project gates in `bandit.json` (`bun test`, `bunx tsc --noEmit`) on the same commit, so the
card passes only when the branch removes more lines than it adds under `src/` AND every test and type check
stays green: check-preserving deletion, the compression-progress "discovery". Write the `## Task` as what to
remove or merge; `--path` narrows the measured directory.

Ratify with the verb's own file as the check path: `bandit ratify <id> --paths src/shrink.ts`. The judge runs
`verify` from the candidate's tree, so without that pin a candidate could pass by editing the verb; this is
why `src/shrink.ts` runs on its own and imports only node builtins (`src/cli.ts` stays free to shrink).
Caveat: the gates keep the *remaining* tests green. Deleting a test under `tests/` does not count toward the
net drop under `src/`, but nothing stops it either; review the diff's test deletions, or add the specific
tests the deletion must keep to the card's `--paths`.

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
bandit ratify measures          --paths tests/seed/measures.check.ts
bandit ratify progress-order    --paths tests/seed/progress-order.check.ts
bandit ratify shrink-check      --paths tests/seed/shrink-check.check.ts
bandit ratify port-guard        --paths tests/seed/port-guard.check.ts
bandit ratify port-status       --paths tests/seed/port-status.check.ts
bandit ratify port-work         --paths tests/seed/port-work.check.ts
bandit ratify adapters          --paths tests/seed/adapters.check.ts
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

The progress cards (base `seed/kept-opus` `a8a4ebf`, bun 1.4.2):

- `measures`: 9 of 9 fail; first, `existsSync(src/measures.ts)` expected `true`, received `false`; `bandit measures --json` exits 1 (`unknown command: measures`), expected 0.
- `progress-order`: 28 of 29 fail; first, `existsSync(src/progress.ts)` expected `true`, received `false`; the loop check claims `a-flat, b-new, c-hot, d-none, e-stuck, f-first` (id order), expected `f-first, c-hot, b-new, d-none, e-stuck` with `a-flat` parked. The one that passes is the default-config guard (no `order` key: id order, no `card.parked`), which must stay green.
- `shrink-check`: 17 of 17 fail; first, `existsSync(src/shrink.ts)` expected `true`, received `false`; `bandit shrink-check` exits 1 (`unknown command`) where 0 and 2 are expected, and prints no JSON where 1 is.

Green-proof, one card at a time: for each of the three, a throwaway implementation of THAT card alone was
applied to a clean tree (base plus the check files, nothing else), its check ran green (measures 3 runs of 3,
progress-order 3 of 3, shrink-check 3 of 3), the other two checks stayed red, `bun test` stayed 177 pass,
1 skip, 0 fail and `bunx tsc --noEmit` clean; then the tree was reverted to clean before the next card. So
none of the three depends on another's change. That code was not kept. Default suite with the three checks
added: `bun test` 177 pass, 1 skip, 0 fail; `bunx tsc --noEmit` clean.

The port cards (base `seed/kept-opus` `d09f5e4`, bun 1.4.2):

- `port-guard`: 20 of 20 fail; first, `existsSync(src/port.ts)` expected `true`, received `false`; `bandit guard` exits 1 (`unknown command: guard`) where 0 and 2 are expected.
- `port-status`: 15 of 15 fail; first, `existsSync(src/port-status.ts)` expected `true`, received `false`; `bandit status --json` exits 1 (`unknown command: status`), expected 0.
- `port-work`: 17 of 17 fail; first, `bandit next --json` prints no JSON (`unknown command: next`, exit 1); the empty-backlog case expects exit 3, received 1.
- `adapters`: 22 of 22 fail; first, `existsSync(adapters/README.md)` expected `true`, received `false`; with no hook, staging `src/kernel/judge.ts` commits (exit 0, expected non-zero); `adapters/claude-code-mod/hooks/register.js` does not exist.

Green-proof, one card at a time, in place on this tree: for each card a throwaway implementation of THAT card alone
(written from the card's Task, nothing else applied) made its check green 3 runs of 3 (port-guard 20/20, port-status
15/15, port-work 17/17, adapters 22/22) while the other three checks stayed red, `bun test` stayed 177 pass, 1 skip,
0 fail and `bunx tsc --noEmit` clean; then the tree was reverted (`git checkout -- src/`, new files removed,
`git status` showing only the seed files) before the next card. For `port-work` the loop check was also run with the
throwaway `src/port-work.ts` but WITHOUT its one-line `src/loop.ts` condition: it fails (`card.reclaimed` for the held
card), so the check proves the lease, not the verbs alone. That code was not kept.

Notes for the port cards:

- `port-work`'s lease is a `port.next` event naming the claim it extends (`pid` + `startedAt` of the `bandit next`
  process that called `claimCard`) and a `leaseUntil`; `runLoop` skips an in-progress card while that lease is live and
  reclaims it as a dead claim afterwards. No kernel change: `claimCard` and `latestClaim` are used as they are; the
  decision to reclaim already lives in `src/loop.ts`. Known gap: `submit` does not re-check the lease while the judge
  runs, so a lease that expires mid-judge can be reclaimed by a loop under it (the move then fails and `submit` exits 2).
- `adapters`' Claude Code mod is built on code.claude.com/docs/en/plugins/mods (overview, events, reference, test,
  v2.1.289); the card quotes the lines it relies on. `$.session.cwd()`'s return shape is not shown there; the card says
  to `await` it. The check drives `register` with fakes, because the docs' own kit (`claude plugin test`) needs the
  `claude` CLI.

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
