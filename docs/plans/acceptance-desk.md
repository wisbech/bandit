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

## 8. Gauges

A gauge is a fast, typed predictor for the hard-to-measure qualities of a text: "does this note cite evidence?", "does it say what to do differently?". It turns those questions into probabilities, records them in the ledger, and can be a card's `verify:` gate. It is built on the decision port and adds no organ.

### The port

`DecisionPort.ask(state, questions, timeoutMs?)` sends several questions about one text in one request and returns normalised answers, or null:

- `noul` returns `{p}` (0..1).
- `choice` returns `{label, probabilities}`. The label is the top probability; every key must be one of the given labels.
- `score` returns `{value}` (0..1 along the ordered labels). Live laya-serve answers with `score`, the expected index over the labels, so value = score / (labels - 1). The older `answer`/`probability` shape is still accepted.

All or nothing: one missing or malformed answer makes the whole call null. The null port returns null. `demonstrates`, `vacuous` and `choose` now sit on `ask`, with the same behaviour as before. `failureSimilarity` stays on the raw wire under the freeze. It reads `answer`/`probability`, which live laya-serve does not send for a score question, so today it returns null against laya-serve and the loop falls back to the regex. Switching it to `ask` would change the stagnation signal, so that waits for the readout.

### The file

`.bandit/gauges/<name>.json`:

```json
{"name": "learned-note", "about": "one line",
 "questions": {"<id>": {"type": "noul|score|choice", "instructions": "...", "criteria": ..., "pass": {"min": 0.3, "max": 1, "is": "lesson"}}}}
```

- `criteria`: `choice` takes `{label: description}` with at least two labels. `score` takes an ordered list of at least two labels. `noul` takes none.
- `pass`: `noul` and `score` take `min` and/or `max` (the reading must be inside the range); `choice` takes `is` (the top label must equal it). A question with no `pass` is informational.
- A malformed file is a usage error (exit 2). The wire never sees `pass`.

### The verb

`bandit gauge <name> (--file <path> | --text <s> | stdin) [--json] [--timeout-ms N]`

- One request for all questions. The default timeout is 30 s because the first call after idle took 17 s; later calls take about 250 ms.
- Prints one line per question (id, type, reading, pass / FAIL / info), or the structured result with `--json`.
- Emits `gauge.read`: gauge, source (file path, `text` or `stdin`), sha256 of the text, `truncated`, readings, verdict.
- Exit 0 when every question with a `pass` rule passes (or none has a rule), 1 when any fails, 2 for usage errors and when the evaluator is not configured, unreachable, or answers malformed. No reading is never a pass. So `verify: bandit gauge learned-note --file notes/lesson.md` is a valid card gate (it needs `bandit` on the PATH of the gate).
- Texts are cut at 8,000 chars, the adapter's ceiling, and flagged `truncated`. Upgrade path, when a real gauge needs long texts: chunk at the ceiling, ask each chunk, aggregate (max for "cites evidence", mean for tone).

### Calibration

`bandit gauge <name> --calibrate <examples.jsonl> [--json]`. Each line is `{"text": "...", "expect": {"<id>": true | false | "<label>"}}`. For each question with expectations it reports n and the accuracy at the current `pass` rule. For `noul` and `score` it also reports the threshold in 0.05 steps that maximises accuracy (predict true when reading >= t; a range means several thresholds tie) and the mean reading for expected-true and expected-false examples, which is the separation. For `choice` it reports top-label accuracy. It never edits the gauge file. Exit 0, or 2 for usage or no reading.

**The rule: thresholds come from labelled examples, never from intuition.** Raw probabilities separate good from bad but are not calibrated. A clearly evidence-backed note read 0.46 on "cites evidence" and fluff read 0.08. A threshold of 0.5 would have failed the good note. That is why the starter gauge `examples/gauges/learned-note.json` ships without `pass` rules. Copy it to `.bandit/gauges/`, label your own notes, calibrate, then write the thresholds.

### Lessons from the Laya authors that apply

- Ask what the text says, not what to do. "Does this note cite a date?" reads better than "should we keep this note?".
- Do arithmetic in code and hand the model the conclusion in words. Compute "latency rose 22x" yourself; don't ask the model to compare 40 and 900.
- Wording matters. Try two or three phrasings of a question on the same examples and keep the one that separates best. Calibration is the measuring tape.
- Send unsure cases to a person or a slower model. A reading inside the gap between the classes is an abstention, not a verdict.

### First calibration, 3 Oct 2026

Starter gauge, the 16 committed examples (4 evidence-backed lessons, 4 vague opinions, 4 descriptions of which 2 cite numbers, 4 todos), local laya-serve (`laya-rl-agent`), two runs with identical readings:

```
  question     type      n  acc@rule  best t       acc@best  mean T  mean F
  evidence     noul     16  -         0.30         1.00      0.60    0.11
  actionable   noul     16  -         0.25         1.00      0.45    0.11
  kind         choice   16  0.81      -            -         -       -
```

- `evidence`: expected-true readings span 0.32 to 0.80 and expected-false 0.04 to 0.28. The gap is 0.04 wide, so only t = 0.30 separates them.
- `actionable`: true 0.28 to 0.64, false 0.05 to 0.21. The gap is 0.07 wide.
- `kind`: 13 of 16. Two opinions ("Great sprint everyone...", "the deploy process feels clunky...") read as `description`, and one description (the on-call rotation) as `todo`. Lessons and todos were all right.
- Read: the gauge separates these examples, but the margins are thin and the thresholds were picked on the same 16 notes, which were written by the same hand that labelled them. That is good enough for an advisory reading or a gate with an abstain band (for example 0.25 to 0.35 on `evidence` goes to a person). It is not yet enough for a hard gate. Next step: 40 or more real notes labelled by someone else, calibrate on half and check on the other half.

### Known limits

- 8,000 chars per reading (head only, flagged).
- Cold start: 17 s for the first call after idle. Gate timeouts must allow for it.
- Uncalibrated out of the box: the starter gauge has no thresholds, and any thresholds hold only for the evaluator model they were measured on.
- Calibration sends one request per example, in sequence. That is fine at 16 examples (6.5 s warm, measured) and slow at thousands.
- `emit` writes under the current directory, so run `gauge` from the board directory, as with `accept`.
