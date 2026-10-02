# Acceptance desk: bandit above any harness

John, 2 Oct 2026: "I like the acceptance desk idea above a harness ... it needs to be pluggable and the jev interface part is needed."

## 1. Position

Agent harnesses (opencode, OpenHuman, Claude Projects, OpenAI Dots) keep agents working. None of them owns an
independent definition of done. Bandit is that: **card in, branch out, verdict by a gate the worker does not own.**
Bandit stops growing harness features (scheduling, memory, sandboxing, routing prose).

## 2. What already exists (do not rebuild)

- `src/decisions.ts`: `DecisionPort` with an adapter registry and a fail-closed null port.
- `src/evaluator-systemone.ts`: the SystemOne wire (`POST /v1/systemone`), served by local `laya-serve` and by hosted Jev. Uses `noul` and `score` today.
- `src/runner.ts`: `TransportConfig`, harness profiles in `.bandit/harnesses/*.json`, card-owned `verify:` run by argv with no shell.
- Verified 2 Oct: local `laya-serve` answers a `choice` question (`criteria` = label -> description) with per-label probabilities in about 1.6 s.

## 3. Three additions

### A. `bandit accept` (the desk)

    bandit accept <card-id> --ref <branch|sha|pr-number> [--repo <path>] [--post]

1. Resolve the ref (a PR number resolves through `gh pr view --json headRefName,headRefOid`).
2. `git worktree add` a throwaway worktree at that ref. Never touch the caller's tree.
3. Run, in the worktree: the card's `verify:` argv, then every project gate in `.bandit/config.json` `gates: [[argv...], ...]` (for TFD: the full test suite). All must exit 0.
4. Ask the decision port `demonstrates` and `vacuous` exactly as the loop does today (shadow: recorded, never voting, until a disagreement is measured).
5. Emit `acceptance.started|passed|failed` events with ref, sha, per-gate exit codes and bounded output. Exit code 0 only on pass. `--post` writes the verdict as a PR comment via `gh`.
6. Remove the worktree.

The worker is anything that can produce a branch. That is the whole plug.

### B. Local workers produce branches too

`runLoop` runs each card in its own worktree (`.bandit/worktrees/<card-id>`, branch `bandit/<card-id>`). The
per-round self-verify stays what it is (the card's verify, now with the worktree as cwd): mid-round work is
uncommitted, so it cannot go through `accept`, which checks out a committed sha and runs the full project gates.
Green: the work is committed, the branch is kept and `task.converged` carries its name; the caller runs
`bandit accept` on it, merges, or opens a PR. Not green after the last round: worktree and branch are removed and
`isolation.discarded` is emitted. This is "failed-card isolation", the first mechanism the 30 Sep run justified
(three failed cards left debris in the shared tree).
Opt-in per project: `.bandit/config.json` `"isolation": "worktree"`; default stays `"shared"` so nothing changes for existing boards.

### C. Choice on the decision port (the Jev interface)

    choose(state: string, instructions: string, options: Record<string, string>): Promise<Record<string, number> | null>

- SystemOne adapter: one question of `type: "choice"`, `criteria: options`; returns `answers.<q>.probabilities`. Null port returns null.
- The port now speaks all three Jev question types: Choice, Score, Noul.
- First use, routing: the master's consult reply is parsed for `DECISION:` as today. When that line is missing (2 of 6 replies on 30 Sep), ask `choose` over proceed / amend / reject / specialist / escalate with the reply as state. Take the top label only if its probability is at least `ROUTE_MIN_P = 0.5`; otherwise `escalate`. Emit `consult.decision` with `source: "line" | "choice" | "floor"` and the probabilities.
- Config: `decisions.evaluator = "systemone"`, `decisions.endpoint` = local laya-serve or a hosted Jev route. No credential in the repo.

## 4. Not in scope

Driving closed harnesses directly, parallel attempts, model escalation ladders, a lever governor, any new organ.
Each waits for a measured trigger.

## 5. Acceptance of this work

- `bun test` green, with tests for: accept pass, accept fail on card verify, accept fail on a project gate, worktree always removed, PR-number resolution (gh stubbed), isolation keeps a green branch and removes a failed one, shared mode unchanged, `choose` adapter mapping, routing fallback (line wins, choice used when missing, floor escalates, null port escalates).
- A live smoke run of `bandit accept` against one TradingFrontDesk draft PR, verdict recorded here.

## 6. As built (2 Oct 2026)

- Commits `b5f41f2` (Choice + routing fallback), `980cddf` (`bandit accept`), `82e8afd` (worktree isolation). `bun test` 131 pass, three runs, type check clean.
- Live verdict: `bandit accept tfd-pr1 --ref 1 --repo TradingFrontDesk` from a throwaway board, card verify `uv run pytest -q desk/execution`, project gates `uv run pytest -q` and `uv run python trading_agent/verify.py`. All three exit 0 at `d1fa07a3b599` in 57 s; the temporary worktree was removed. `--post` was not used.
- Card `verify:` is a string split into argv without a shell, not a JSON array. A card without `verify:` is a usage error in `accept`.
- The Choice fallback is wired at the routing consult only. Plan and stagnation consults still read a missing DECISION line as before.
- `escalate`, `reject` and `proceed` all land the card in review today, so the floor case changes the recorded decision, not the path.

## 7. Known gaps

- The decision adapter times out at 2 s and a cold local evaluator call took 1.6 s: early routing calls can hit the escalate floor. Raise `decisions.timeoutMs` in the project config rather than the default.
- `emit` writes under the current directory, so `accept` must be run from the board directory.
- If `git worktree add` fails, `acceptance.started` has no matching verdict event (CLI exits 2).
- If the commit on convergence fails, the worktree is kept and the card still moves to done.
- `--post` is tested with a stubbed `gh` only.
