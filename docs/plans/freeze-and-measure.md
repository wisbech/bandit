# Freeze and measure — seven fixes, then twenty real cards

Status: PHASE 1 + 1b DONE (2026-09-30) on branch `freeze/seven-fixes` (tag `pre-freeze` marks main before it): fixes 1-7, the hazard fix (`src/verify.ts`, card-owned `verify:`, argv spawn, fail-closed `verification.unverifiable`), `bandit reopen`, and one extra gate fix found during review (a claimed exit code with no command was green). 112 tests, tsc clean. TFD has `desk/scoreboard.py` (commit 1f928a5, pushed). Not merged to main, not pushed. Next: Phase 2 card list.
Loose ends carried into Phase 2: TFD card 011 is budget-exhausted on the frontier; `verification.unverifiable` is not yet rendered by board/watch/dossier; the scoreboard reads `.bandit/tmp/walkforward_report.json`; the fix-2 test holds a persistent loop open and adds ~9 s to the suite.
Date: 2026-09-30
Rule in force: no new mechanism until the twenty-card run produces a number that asks for one (kiss-discipline §1). One instrument is allowed (`bandit reopen`) because the measurement cannot be honest without it.

## 1. Why

The 2026-09-30 review found the mechanical gate right 3/3 and the LLM grader wrong 3/3 on the only adversarial card in the log, six line-level bugs, and a ledger that has never accumulated a real pull. TradingFrontDesk's own log agrees: 45 red gates vs 9 green, 61 grader repairs, 12 failed cards, every ledger pull "flat". Before any new organ, fix what is broken and measure on real work.

## 2. Phase 0 — safety baseline (done by the DA, ~15 min)

- TFD: **DONE 2026-09-30** — baseline commit `31724b6` pushed to `Willowtree-Commodities/TradingFrontDesk` (private). 422 files; scratch, snapshots and per-card `.bandit/` dirs ignored; `secrets/.env` not tracked; staged content scanned for key patterns, none found.
- bandit: branch `freeze/seven-fixes` from main; tag `pre-freeze`.

## 3. Phase 1 — the seven fixes (Opus, sequential, one commit each)

Each fix: smallest diff, one test that fails before and passes after, `bun test && bunx tsc --noEmit` green, nothing else touched. Commit message `fix(N): <title>`.

| # | Bug | Where | Smallest change | Test |
|---|---|---|---|---|
| 1 | Plan phase runs twice per non-trivial card | `src/loop.ts:889-892` and `:581-582` | Delete the outer call in `runLoop`; `convergeCard` owns the plan phase | Stub transport counts prompts with `planOnly`; standard card → exactly 1 |
| 2 | Wake reentrancy guard never set | `src/loop.ts:944-960` | `waking = true` before the inner `runLoop`, `finally { waking = false }`; after the pass, if backlog non-empty, wake again once | Fire two board events 10 ms apart → one pass; a card added mid-pass is still processed |
| 3 | Triage overwrites the grading record | `src/loop.ts:713` via `runCritic` `:211-212` | Add `record = true` param to `runCritic`; triage passes `false` and does not write `grading/<card>.md` | After a red round, `grading/<card>.md` still holds `VERDICT:` from the grade, not the triage |
| 4 | Agent-profile path differs between pane and headless | `src/cli.ts:646` vs `src/runner.ts:792` | One helper `agentProfilePath(root, role)` = `<root>/.opencode/agents/<role>.md`; both sites call it | Unit test on the helper; existing TFD `.opencode/agents/critic.md` resolves |
| 5 | Budget counts chars/4, real tokens discarded | `src/runner.ts:202-224`, `:317` | `eventsToText` returns `{ text, tokens }`; headless uses `tokens` when > 0, else the estimate | JSONL fixture with two `step_finish` lines → `tokensUsed` equals their sum |
| 6 | Actor runs with cwd = card folder | `src/runner.ts:797`, `:665-666`, `src/loop.ts` callers | Actor and self-verify run from project root; card path passed as `{{card.dir}}`; TMPDIR = `<root>/.bandit/tmp`; delete the four-levels-up hack | Stub transport asserts `cwd === root`; `verification-output.log` still lands in the card folder |
| 7 | The lever is the card id, so pulls never accumulate | `src/loop.ts:557-561` | Lever id from the `## Lever` section's first line, slugified (`lever:<slug>`), or frontmatter `lever:` when present; fall back to card id only when both are absent | Two cards naming the same lever → one ledger claim with `pulls = 2` |

Zero-risk deletions ride in the last commit: `processed += 0` (`loop.ts:899`), `explorationShareFor` + `void` (`confidence.ts:214-218`). Update the README test count.

Gate for Phase 1: 96+7 tests green, tsc clean, `bandit doctor` passes in TFD, one dogfood card on bandit itself converges without a hand event.

## 4. Phase 1b — the host-exec hazard (decision required)

The gate runs the actor's `VERIFICATION_COMMAND` through `bash -c` on the host as the operator. This is a feature under the freeze, so it is a choice, not an assumption. Recommended minimum before Phase 2 runs unattended on a repo with a `secrets/` folder:

- L1 card-owned verify: `bandit task --verify "<cmd>"` stored as argv in frontmatter; the gate runs the card's command; the actor's reported command is logged and compared, never executed.
- L2 argv spawn: `Bun.spawn(argv)`, no shell. Shell metacharacters become inert. The backtick false-red class disappears.
- L3 fail-closed: actor-proposed commands only run when `verificationContainer` is set; otherwise the gate is red with reason `unverifiable`.

Roughly 80 lines. Skip it and Phase 2 runs with the operator watching, not overnight.

## 5. Phase 2 — twenty real cards on TradingFrontDesk (Opus supervises, headless)

**Cards.** Twenty, small, each with a mechanical verify command and a `## Lever` line naming one of the levers in `.bandit/goal/goal.md`. Source: TFD has no test suite outside a probe, so the first ten are "add a test for <module>" cards (`uv run pytest tests/test_<module>.py -q`); the next ten come from the A2 roadmap items in TFD `docs/plans/`. Card 011 (amend-requeued) and 007 (review) are included as-is.

**The lever, made real.** Every card names a lever from goal.md. `.bandit/goal/active-lever.txt` is set. A measure exists only if something emits it: one script, `desk/scoreboard.py`, prints the goal.md scoreboard (OOS CAGR, Sharpe, MaxDD) as JSON; the DA appends it to `.bandit/goal/measures.jsonl` after each converged card. `strengthen` fires only on a measure delta, not on "card converged". If this is too much for the freeze, the ledger stays as-is and the readout reports pulls-per-lever only.

**Rules.** Nobody touches the board by hand. Every human intervention goes through `bandit reopen <id> --reason "<text>"`, which emits `card.moved` with `by: "hand"` through `emit()`. That event count is the headline number.

`bandit reopen` exists (src/cli.ts `reopen` → `reopenCard` in src/loop.ts); `--reason` is required and the card may be in any column.

**Metrics, all from existing events:**

| Metric | Computed from |
|---|---|
| Cards converged with zero hand events | `card.completed` minus cards with any `by: hand` |
| Hand events per card | `card.moved` where `by = hand` |
| Grader vs gate agreement | `critic.verdict` joined to `verification.*` on card + round |
| Rounds per converged card | `round.started` count per `converged` |
| Transport red rate | `transport.empty_output` / `round.started` |
| Plan calls per card | `plan.started` per card (must be 1 after fix 1) |
| Pulls per lever | ledger `pulls` grouped by lever id (must exceed 3 for at least two levers after fix 7) |

**Stop conditions.** Any write outside the TFD tree; three consecutive `transport.red`; any card touching `secrets/`. Stop, diagnose, do not add mechanism.

## 6. Opus handoff prompts (one per fix, run in order, in the bandit repo on `freeze/seven-fixes`)

Prefix for every prompt: "You are fixing exactly one bug in /Users/wrill/Documents/Codiac/Agents/bandit. Read the cited lines first. Make the smallest diff that fixes it, add one test in `tests/fixes.test.ts` that fails before and passes after, run `bun test && bunx tsc --noEmit`, commit as `fix(N): <title>`. Touch nothing else. No refactors, no comments about the fix elsewhere, no doc edits except the README test count in the final commit."

1. "Bug 1: `runLoop` at `src/loop.ts:889-892` calls `runPlanPhase`, and `convergeCard` at `:581-582` calls it again for the same card. Delete the outer call. Test: a standard card through a stub transport records exactly one prompt containing the plan-only render."
2. "Bug 2: `src/loop.ts:944` declares `waking`, `:957` reads it, nothing sets it. Set it true around the inner `runLoop({...config, once: true})` with a `finally`, and after the pass re-run once if `cardsIn('backlog').length > 0`. Test: two `onBoardEvent` calls 10 ms apart produce one pass; a card created during the pass is processed."
3. "Bug 3: `src/loop.ts:713` calls `runCritic` for triage; `runCritic` writes `grading/<card>.md` at `:211-212`, overwriting the grade. Add a `record = true` parameter; the triage call passes `false` and skips the write. Test: after a red round the file still contains the grade's VERDICT line."
4. "Bug 4: `src/cli.ts:646` resolves agent profiles under `.bandit/.opencode/agents`; `src/runner.ts:792` under `<root>/.opencode/agents`. Add `agentProfilePath(root, role)` in `runner.ts`, use it at both sites. Test: the helper returns `<root>/.opencode/agents/<role>.md`."
5. "Bug 5: `src/runner.ts:202-224` parses real token counts in `eventsToText` and drops them into a text line; `:317` estimates `text.length / 4`. Return `{ text, tokens }` and use `tokens` when it is greater than zero. Test: a JSONL fixture with two `step_finish` events yields `tokensUsed` equal to their sum."
6. "Bug 6: `src/runner.ts:797` runs the actor with `cwd = opts.cardDir`; `:665-666` climbs four levels to find the root. Pass `root` into `runSerfOnCard` and `selfVerifyGateAsync`; run both from root; expose the card path to the prompt as `{{card.dir}}`; set TMPDIR to `<root>/.bandit/tmp`. Update the actor prompt template in `src/cli.ts` init to include `CARD FOLDER: {{card.dir}}`. Test: stub transport asserts `cwd === root` and the verification log still lands in the card folder."
7. "Bug 7: `src/loop.ts:557-561` returns `lever:<card.id>` regardless of the `## Lever` text, so no lever ever accumulates pulls across cards. Derive the id from frontmatter `lever:` if present, else the slugified first line of the `## Lever` section, else the card id. Test: two cards with the same lever text produce one ledger claim with `pulls = 2`. In this final commit also delete `processed += 0` (`loop.ts:899`) and `explorationShareFor` plus its `void` line (`confidence.ts:214-218`), and set the README test count."

## 7. Phase 3 — readout

One table in this file under "Results", one paragraph of interpretation, and the single next mechanism the numbers ask for, if any.

## 8. Parked, on purpose

The organic organisation — risk management, FinOps watching market structure, each a folder with a description and a surveillable service — is the right long-term shape and it is exactly what the freeze protects. Note that the zero-mechanism version already exists: `bandit serf risk --prompt "<mission>"` gives the folder and the identity; a `desk/risk_check.py` with a CLI is the service; the watcher is the surveillance. Nothing in bandit has to change to run that experiment. It gets a card in Phase 2 if John wants it measured.

## 9. Results — the twenty-card run, 2026-09-30

One pass, `bandit start --once`, headless opencode on `ollama/glm-5.3-flash:cloud`, TradingFrontDesk, 07:30Z to 12:49Z (5 h 19 min). bandit at `29ab9bf` (the fixes after that commit were not loaded by the running process).

| Metric | Value |
|---|---|
| Cards converged with zero hand events | **14 / 20** |
| Cards to review after 3 rounds | 3 (06 backtest test, 10 agent-cycle test, 19 kill-switch restart) |
| Cards requeued by `amend` route | 3 (12 regime probe, 17 wheel, 18 put spread), bounded at 2 requeues |
| Hand board moves | **0** |
| Hand actions of any kind | 1 (full walk-forward report regenerated after card 15 left a SPY-only one; logged in `measures.jsonl`) |
| Grader vs gate agreement | **37 / 37** (0 contradictions; on 28 Sep it was 3 / 6) |
| Rounds total / hitting the 600 s run budget | 38 / 15 |
| First-round green | 10 / 20 |
| Rounds per converged card | 1: ten cards · 2: two · 3: two |
| Routing decisions parsed | amend 3 · specialist 1 (capability captured) · null 2 (master reply was tool calls only) |
| Plan phases per card | 0 (all cards classified trivial: ≤3 acceptance lines) |
| `transport.empty_output` / `unverifiable` | 0 / 0 (every card carried `verify:`) |
| Pulls per lever | verification-harness 15 · premium-track 6 · sharpe-floor 5 · pooled-risk-sizing 2 · regime-veto 3 · universe-diversification 3 · risk-constitution 3 |
| Refiner | fired once at the end (trigger reads all-time events: "critic plumbing x72", none from today), proposed 0 edits |

**The lever moved on paper, not on the desk yet.** Adoption table (card 14), same stitched folds, no refit, every probe re-run by the DA and reproducing exactly:

| Lever | Sharpe | CAGR | MaxDD | Decision |
|---|---|---|---|---|
| A1 baseline | 0.980 | 9.7% | 16.4% | |
| pooled equity vol targeting | 1.070 | 10.0% | 12.7% | adopted (IS 1.186 vs OOS 1.07, card 20) |
| regime veto entry gate | 0.999 | 8.8% | 12.5% | rejected, Sharpe < 1.0 |
| universe diversification (XLU/XLE/GLD) | 0.973 | 7.1% | 14.2% | rejected |

The desk scoreboard is unchanged (0.98 / 9.7% / 16.4%) because adoption has not been wired into `run_walkforward.py`. That wiring is the next card, and it is the one that turns the probe's number into the measure.

**What the gate caught that nothing else would have.**
- Card 15 moved the report path correctly and then regenerated the report with `--symbols SPY` to make its test fast: the desk's measure silently became a one-symbol number (Sharpe 0.715, MaxDD 24.8%). Found by reading the scoreboard after the card, not by any organ.
- Card 10 failed and left 86 uncommitted lines in `trading_agent/agent.py`, including a call to a function defined below its use (NameError on import with no argv).
- Cards 17 and 18 failed and left partial test files; `pytest tests` now reports 12 failed / 225 passed. Every converged card's tests pass.
- Card 14 wrote and ran the regime probe that card 12 never finished; its numbers reproduce, so it was real work, not a fabricated row.

**What the numbers ask for (in order).**
1. **Adoption wiring** (TFD card): `run_walkforward.py --sizing pooled` and the A2 constant set; regenerate; scoreboard reads the adopted desk. No bandit change.
2. **Measure guard** (TFD card, ~10 lines): `desk/scoreboard.py` refuses a report whose `symbols` differ from `StrategyConfig.universe`. Closes the card-15 hole.
3. **Failed-card isolation** (bandit, the first mechanism the data justifies): a non-converged card must not leave edits in the shared tree. Cheapest form: `git stash`/checkout of the card's touched files on `task.failed`, recorded as an event; full form: a worktree per card. Evidence: agent.py, wheel, put_spread.
4. **Refiner window**: trigger over events since the last refine, not all time. Evidence: fired on 72 historical plumbing events with zero today.
5. **Master consult prompt**: two of six routing replies were tool calls with no DECISION line; the master's `prompt.md` in TFD is refiner notes with no identity block. Prompt fix, not mechanism.
6. **Run budget**: 15 of 38 rounds hit 600 s; the hard cards converge on round 2 or 3 by accumulating files across rounds. A per-card `runTimeoutMs` in frontmatter is a config knob, not a mechanism; try 900 s on probe cards before anything else.
7. **Grader**: 37/37 agreement means it added no information today. Keep it in shadow (record, never vote) until a disagreement appears; that is the kiss-discipline row, now with data.
8. **HRP sizing probe** and **daily GEX instrument** (TFD cards) per the discussion of 30 Sep: the first because card 13's equal-weight diversification failed and card 16 built the cluster tree; the second as a recorded instrument for the regime veto, not a backtestable lever.

**Not asked for by the numbers:** Thompson governor, consult debate, specialist execution, per-criterion calibration, bandit forest, any new organ.

**Post-run cleanup by hand (John's call, 2026-09-30):** `agent.py` reverted; `wheel.py`, `put_spread.py` and their tests moved into the requeued cards' folders under `leftover/`; converged work committed to TFD `master` and pushed. Three hand actions on the working tree, still zero on the board. These are exactly what failed-card isolation (next step 3) would have made unnecessary.
