# The seed: a mechanism that builds on itself

## Context

Bandit today is generate-and-test with a trustworthy gate. On 30 Sep a cheap model converged 14 of 20 cards
unattended, the gate agreed with the grader 37 of 37 times, and nothing steered or learned between cards. John's
direction (2 to 4 Oct): bandit is an acceptance desk above any harness, it should be able to improve itself, it must
leave real output in the world and not only a record, and locks and polling are antipatterns.

The agreed mechanism is six parts and five rules. This plan carves that mechanism out of the code that exists,
closes the three places where the code breaks its own rules today, and then lets the loop build its remaining parts
from a seed backlog. Stage 1 is the experiment: the share of its own backlog that it converges, judged by checks it
cannot edit, measures how much of itself it can build.

**Parts:** log, card, judge, loop, score, body of work.
**Rules:**
1. Nothing counts until the judge says so.
2. The judged cannot edit the judge, the log, or a card's check.
3. Every change is a card, every card has a check, every outcome is logged, including changes to the mechanism itself.
4. Keep what raises the score, revert what lowers it.
5. A failure writes the next card. A human ratifies each new check.

## What the code does today that breaks the rules

Found by reading the tree at `feat/acceptance-desk` (`a7dcc46`):

- **Rule 1.** `runLoop` moves a card to done on the worker's self-verify (`src/loop.ts:961-967`). It never calls the judge (`acceptRef`, `src/accept.ts:72`).
- **Rule 2.** The judge reads `verify:` from the live card, which the worker can reach. A check such as `bun test tests/x.test.ts` runs the candidate's own copy of the test. This is the hole a card used on 30 Sep.
- **Rule 4.** `.bandit/` is git-ignored, so prompts, cards and config are outside git. "Git is the stack" cannot revert a prompt edit, and no diff can show a check was edited.
- **Log.** `emit` (`src/loop.ts:82`) writes `{type, ts, ...payload}` with no sequence or hash, resolved from the current directory. A second writer and four duplicate readers exist (`refiner.ts`, `watch.ts`, `dossier.ts`).
- **Claims.** `runLoop` adopts every card in `in-progress` as its own (`loop.ts:929`). `moveCard` resolves "wherever the card is now" (`loop.ts:118`). The pid lock in `cli.ts:348-367` is check-then-write, and a visitor still processes its first pass.
- **Refiner.** Triggers on all-time event counts (`src/refiner.ts:91-101`), so once past the threshold it fires forever. It applies edits directly with no measured keep or revert.
- **Score.** Nothing records a measure. `rankLeversForPull` and the Thompson governor have no production caller.

## Design decisions

- **Kernel.** `src/kernel/{log,card,judge,score}.ts` plus `KERNEL.md` (the rules and the kernel path list). Deterministic: no model calls inside it. The decision-model shadow questions move out of the judge into a wrapper.
- **Log.** One segment file per writer process per day, `events/<date>.<writer>.jsonl`. Each event carries `writer`, `seq` and `prev` (sha256 of the previous line). Appends need no lock. No cross-segment graph. Tamper evidence comes from an anchor the worker cannot rewrite: segment head hashes go in the trailer of each kept merge commit. `bandit log verify` checks chains; old unchained files report as pre-genesis.
- **Checks the judged cannot edit.** A human-only `bandit ratify <card>` logs `card.ratified {verifyArgv, checkPaths, sha256, baseSha}`. The judge takes the argv from that event, restores `checkPaths` from `baseSha` into its worktree, and fails any candidate whose diff touches check paths, kernel paths, `package.json` or `bunfig.toml`. Project `gates` and `score` move to a tracked file, `bandit.json` at the repo root.
- **Kernel boundary.** Enforced by the judge's diff rule, by `CODEOWNERS`, and by the loop never merging a kernel diff. A flag on the command line is not a boundary.
- **Claim by rename, no lock.** Claim is `rename backlog/<id> -> in-progress/<id>`; losing the race is `ENOENT`. Every move names its expected source column and checks the latest `card.claimed` writer is itself. A factory only works its own claims. A dead claimant (pid not alive) is reclaimed by `rename in-progress/<id> -> backlog/<id>`, then a normal claim. The directory is the only truth; the `column:` rewrite goes.
- **Body of work.** With `"keep": "merge"`, a judged branch merges into an integration branch `bandit/kept` with the verdict and log-head hashes in the commit trailer. A human fast-forwards `main`. This also lets card N+1 see card N. Default stays `"branch"`.
- **Score.** `score` in `bandit.json` is an argv printing one JSON number from outside the loop. `bandit score` logs `score.read` at each keep. It gates only when declared deterministic. For bandit itself the score is cost per judge-accepted card on a frozen benchmark board with human-owned checks.
- **Self-edit is a card.** The refiner stops applying edits. It writes proposal cards. Serf prompts and the benchmark board move to tracked paths so git can revert them.
- **Keep-or-revert for self-edits.** Paired sign test on a frozen 12-card benchmark, two passes, baseline and candidate interleaved on the same cards. Keep if wins minus losses is at least 5. Abort and revert as soon as losses minus wins reaches 2. On an exact tie keep only if tokens fell on at least 9 of 12 cards. One self-edit in flight at a time. Default is revert.
- **No polling.** Delete the 60 s heartbeat (`loop.ts:1007`). The 10 s idle interval (`runner.ts:272`) becomes a timeout reset by each stream event. The `fs.watch` debounce is not polling and stays.
- **Pause.** A pause file blocks claiming proposal cards. Ordinary cards continue.

## Stage 0: carve the kernel (Opus builds, one commit per step, `bun test` green at each)

Every move leaves a re-export at the old path so the 146 existing tests are untouched.

1. `src/kernel/log.ts` takes `emit` and `readEvents` with an explicit `root`. `loop.ts` keeps a shim.
2. Point `refiner.ts` (`emitSafe`, `readEventsWindow`), `watch.ts`, `dossier.ts`, `accept.ts` at it. One commit each.
3. Add `writer`, `seq`, `prev`, segment filenames, `bandit log verify`.
4. `src/kernel/card.ts` takes `parseCard`, `findCardDir` (`runner.ts:45,89`), `cardsIn`, `moveCard` (`loop.ts:106,116`), `splitArgv` (`verify.ts`).
5. `src/kernel/judge.ts` takes `acceptRef`, `resolveRef`, `projectGates` (`accept.ts`) and `runArgv`, `defaultExec` (`runner.ts:709-745`). Shadow call moves to a wrapper in `accept.ts`.
6. `claimCard`, fenced moves, own-claims-only frontier. Delete `run.lock`, visitor mode and `readOnly` (`cli.ts:348-367,465`, `loop.ts:1013`). Close the lock pull request.
7. `bandit ratify` and check pinning in the judge. `bandit.json` for gates and score.
8. The loop calls the judge on the kept sha before `done`, in isolation mode.
9. `src/kernel/score.ts`, `bandit score`, `KERNEL.md`, `CODEOWNERS`.

Outside the kernel: transports, `convergeCard`, consults, refiner, isolation, watch, cli, decisions, gauge.

## Stage 1: the seed backlog (the loop builds, the judge decides)

For each card a human writes the failing test and ratifies it first. K means it touches the kernel and needs a human merge.

| # | Goal | Check | K |
|---|---|---|---|
| 1 | Idle watchdog becomes a resettable timeout | `bun test tests/idle-timeout.test.ts` | |
| 2 | Remove the heartbeat interval | `scripts/check-no-interval.sh` | |
| 3 | Delete `repairBoardFromEvents` | `bun test` and `scripts/check-absent.sh` | |
| 4 | Refiner triggers on events since its last pass | `bun test tests/refiner-window.test.ts` | |
| 5 | Serf prompts move to a tracked path | `bun test tests/prompts-tracked.test.ts` | |
| 6 | Refiner writes proposal cards and applies nothing | `bun test tests/refiner-proposal.test.ts` | |
| 7 | A failure writes an unratified draft card to `.bandit/drafts/` | `bun test tests/failure-draft.test.ts` | |
| 8 | Cost per accepted card, computed from the log | `bun test tests/cost-report.test.ts` | |
| 9 | `bandit bench`: frozen board in a temp clone, prints JSON | `bun test tests/bench.test.ts` | |
| 10 | Paired sign-test decision function, pure | `bun test tests/keep-rule.test.ts` | |
| 11 | Pause file blocks claiming proposal cards | `bun test tests/pause.test.ts` | K |
| 12 | `keep: merge` into `bandit/kept` with verdict trailer | `bun test tests/keep-merge.test.ts` | K |

Readout: cards accepted by the judge unattended, rounds, tokens, hand actions. Recorded in `docs/plans/seed.md`.

## Stage 2 and 3 (planned, not started by this plan)

- **Stage 2.** Rule 5 live: draft cards from failures, ratified by John.
- **Stage 3.** One self-edit at a time under the keep rule above, on the frozen benchmark. Track cost per accepted card across self-edits. If it stops falling, the loop stops spending on itself.

## Not built yet, on purpose

Cross-segment log graph. More than one factory beyond a correct claim. Automatic reverts before cards 8 to 10 exist.
Lever ledger or Thompson wiring. Auto-ratified checks. Score-gating ordinary cards. Kernel changes proposed by the
loop. Replacing the CLI pane sleeps. Any merge to `main` by the loop.

## Verification

- `bun test` green after every Stage 0 commit, run three times at the end; `bunx tsc --noEmit` clean.
- `bandit log verify` passes on a board written by two concurrent processes, and fails after one line is edited by hand.
- Two `bandit start --once` processes on one board: every card is claimed exactly once (test with a stub worker).
- Gamed-check test: a candidate branch that weakens its own test file is rejected by the judge with the check-path reason.
- End to end on a throwaway clone of bandit: ratify one seed card, run the loop in isolation mode with a stub worker, confirm judge verdict, merge into `bandit/kept`, verdict hash in the trailer, `score.read` logged.
- Stage 1 run and readout against bandit's own repo.

## Decided by John (4 Oct 2026)

1. **Base.** Merge wisbech/bandit#2 (acceptance desk) and #3 (gauge) into `main` first; close #1 (run lock) unmerged with a note that claim-by-move replaces it. The seed work goes on a new branch `feat/seed-kernel` from the updated `main`, delivered as a pull request.
2. **Scope of this execution.** Stage 0 only. Stop for review before the loop is pointed at its own repo.
3. **Stage 1 worker, when it runs.** Both, on the same twelve cards: the cheap model from 30 Sep and Opus subagents, each on its own integration branch, for a like-for-like comparison on a fixed corpus.

## Execution order for this approval

1. Merge #2, then retarget and merge #3; close #1 with the explanation. Confirm `bun test` on `main` (146 expected).
2. Branch `feat/seed-kernel`. Hand Stage 0 steps 1 to 9 to Opus in its own worktree, one commit per step.
3. Review each commit's diff; run the verification list above.
4. Write `docs/plans/seed.md` from this plan with as-built notes; open the pull request; stop.


---

# As built: Stage 0 (4 Oct 2026)

Branch `feat/seed-kernel`, 17 commits by Opus in two passes, each reviewed. `bun test`: 178 pass, 1 skip, 0 fail
(146 before). Type check clean. The kernel is 684 lines in `src/kernel/` (`log`, `card`, `judge`, `score`) and
imports only node builtins and itself, enforced by a test.

## What exists now

- **Log.** One chained segment per writer process. `bandit log verify` passed on a board written by four concurrent processes and failed at the right sequence number after a one-character hand edit.
- **Claims, no lock.** `run.lock` and visitor mode are deleted. Two loops on a six-card board claimed three cards each, none twice.
- **Checks the judged cannot edit.** `bandit ratify <card> --paths ...` writes `checks/<id>.json`; a human commits it on `main`. The judge reads the check, `bandit.json` and the protected list from the base ref, restores the check files from base, and fails any candidate whose diff touches them. Live: a candidate that weakened its own test was rejected by the `protected-paths` gate; the honest candidate passed setup, verify and both project gates.
- **Rule 1 in the loop.** In isolation mode a card reaches done only after the judge passes its kept branch. A judge failure sends it to review and keeps the branch as evidence.
- **Score.** `bandit score` runs the project's score command and logs it. Bandit's own repo has none configured yet.
- **`KERNEL.md`, `CODEOWNERS`, `bandit.json`.**

## Where the build departed from the plan, and why

- **Ratifications live in git, not in the log.** Any process can start a new log segment with a valid chain, so a logged ratification can be forged. A file on the base branch cannot be changed by a candidate.
- **A claim is two renames.** Backlog to a hidden pending name, log the claim, then to in-progress. One rename left a moment where a card was in progress with no claim on record and could be taken twice.
- **Protected paths apply to every candidate with a base,** ratified or not.
- **The docker-dependent test now skips itself** when its container is not running. It is the only existing test whose behaviour changed.
- **Three small test edits:** raw event reads go through a helper (four files), one assertion checks the card's folder instead of a rewritten `column:` line, one removed the deleted `readOnly` field.

## Known unsound, stated in KERNEL.md or to be carded

1. Judge and worker run as the same OS user. The real boundary is git on a protected remote. The judge uses the local `main`, which a worker could commit to.
2. A ratified test still runs candidate code in its own process, so a candidate could patch test globals. Hash pinning protects the file, not its execution.
3. The claim fence is check-then-move. A stalled process could move a card that was reclaimed meanwhile. Claims coordinate honest loops; they are not security.
4. A deleted whole log segment is undetected until log heads are anchored in kept merge commits (seed card 12).
5. Every short command creates a one-event segment, and the latest-claim lookup rereads the whole log per card. Needs compaction or an index before large boards.
6. With `requireRatified`, an unratified candidate that also touches the kernel reports only the ratification failure.
7. Shared mode is unjudged by design; it logs `judge.skipped`.

## Next (not started)

Stage 1: write and ratify the twelve seed cards, then run the backlog twice on the same cards, once with the
cheap model and once with Opus subagents, each into its own integration branch. Add cards for items 2, 3 and 5 above.
