# Architecture

> A serf is a folder. A card is a folder. Events are the truth. Harnesses are adapters. A factory is a node in a tree.

bandit is deliberately boring infrastructure: files, folders, and one imperative loop. No database, no daemon you must keep alive, no state that can't be reconstructed. This document explains why each piece exists and how the pieces compose.

## The one loop

```
board ──▶ pick frontier card ──▶ pipeline ──▶ converge ──▶ done / review
                                  │
                                  ├── plan critique (non-trivial cards)
                                  ├── actor round → verification gate
                                  ├── critic verdict → triage on red
                                  ├── specialist spawn on repeated capability gap
                                  └── ledger update (strengthen / weaken)
```

`src/loop.ts` is the only imperative code. It polls nothing: `fs.watch` on the board wakes it, process exits drive liveness, and the only steady-state writes are holder-side heartbeats. When the board drains, the loop holds open and watches — a card appearing in `backlog/` or `in-progress/` wakes it within 500ms.

## Folder layout

```
.bandit/
├── plan.md               # mission + current direction (read by every serf)
├── config.json           # agent / model / transport / visibility / budgets
├── harnesses/            # adapter profiles — see harnesses.md
├── board/
│   ├── backlog/          # cards waiting
│   ├── in-progress/      # being executed; outputs land inside the card folder
│   ├── review/           # escalations; critic verdicts travel with the card
│   └── done/
├── serfs/
│   ├── actor/
│   │   ├── prompt.md     # standing prompt (template vars rendered per run)
│   │   ├── serf.md       # identity: mission, persona, fate
│   │   ├── state.md      # durable state
│   │   ├── journal/      # append-only working notes
│   │   ├── outputs/      # persisted run outputs
│   │   ├── memory/       # lessons (written by the refiner, with evidence)
│   │   └── children/     # registry of spawned specialists + summoned voices
│   ├── critic/           # consult replies land here — the peer's track record
│   ├── master/           # routing decisions on the consult thread
│   ├── researcher/       # summonable — cites sources, marks unverified claims
│   ├── architect/        # summonable — proposes shapes, names what NOT to build
│   └── <hand-spawned>/   # bandit serf <name> — same folders, same registry
├── events/               # append-only JSONL — the truth
└── goal/                 # confidence ledger + bandit posteriors
```

Every artifact is inspectable with `cat`. If a feature can't be explained as "a file a serf reads or writes," it doesn't go in.

## Cards

A card is a folder, not a row. Everything about the work travels with it:

```
board/in-progress/write-hello-txt-…/
├── card.md          # frontmatter (column, id, title, budget) + body
│                    #   ## Task / ## Acceptance / ## Goal / ## Lever
├── plan.md          # plan-phase output (non-trivial pipelines)
├── gates.json       # verification fingerprints (same failure twice = say something new)
└── outputs/
    └── run-*.md     # every actor run, timestamped, immutable
```

Acceptance criteria drive the gate; the `## Lever` section links the card to the confidence ledger — work is measured by its instrument.

## Events

`.bandit/events/YYYY-MM-DD.jsonl` — append-only, one JSON object per line:

```json
{"type":"verification.green","ts":"2026-09-18T12:19:02Z","card":"write-hello-txt-…","round":1}
```

The board is a *projection* over events. `repairBoardFromEvents()` replays the log and moves folders to where the last event says they belong — a crashed run, an accidentally moved card, or a corrupted projection repairs itself on replay. This is the event-sourcing discipline: state is derivable, truth is the log.

Core event types: `card.created` `card.moved` `pipeline.selected` `plan.started` `plan.finished` `plan.rejected` `round.started` `verification.green` `verification.red` `gate.selfverify` `critic.verdict` `critic.repair` `critic.bypass` `grader.gate_contradiction` `consult.opened` `consult.turn` `consult.decided` `consult.routed` `consult.summoned` `consult.reweighed` `consult.failed` `card.requeued` `card.amend_limit` `converged` `card.completed` `task.failed` `specialist.spawned` `serf.spawned` `card.budget_exhausted`.

## Pipelines

Difficulty-proportional, decided by card shape (acceptance count + body length):

| Pipeline | Plan phase | Rounds | Use for |
|---|---|---|---|
| `trivial` | skip | up to 3 | one-liners, obvious fixes |
| `standard` | yes | up to 3 | normal tasks |
| `hard` | yes + plan critique | up to 3 | multi-acceptance, long bodies |

The plan critique is a cheap gate: the critic rejects bad plans *before* the actor burns execution tokens. A rejected plan goes straight back to the author with the critique attached.

## The critic

The critic is a serf and the master's peer — present from problem-start, not after the failure. Grading is a separate classifier seat (one cheap call from a fixed prompt, track record in `.bandit/grading/`, never a persona). The critic's rules:

1. **It argues in consult threads, not one-way verdicts.** Three bounded consult points per card — plan (before execution tokens burn), stagnation (same wall or different wall?), and routing (the master's decision). The thread lives in `card/consult.md`; only the `DECISION:` line is parseable, everything else is conversation.
2. **It may summon.** `SUMMON: <role>` inside a consult reply spawns a real child serf (origin + registry, src/bandit.ts) whose reply joins the thread — a researcher with sources, an architect with shapes. The voice advises; it never touches the gate, grades, or writes code.
3. **Plumbing failures retry the seat, never the actor.** An unparseable grade is the seat's plumbing problem (up to 2 self-retries), then it's bypassed and documented — the card is never failed because the reviewer hiccuped.
4. **Its verdicts are advisory; the gate is the truth.** A grader pass at a red gate is recorded as `grader.gate_contradiction` — the seat's confidence is self-reported fiction, flagged in the dossier.
5. **Be convincable.** The summoned voices and the critic's own amendments (VERDICT-CHANGE on rebuttal) mean the loop's decisions are made with the best argument in the room — and the thread is the receipt.

The converged condition is deliberately conservative: green verification AND (grading pass, or plumbing-bypass, or fail with confidence ≤ 0.7). A confident grading fail blocks convergence even on green — the actor goes another round. No consult, debate, or rebuttal can turn a red gate green: the Goodhart boundary.

## Confidence: ledger → bandit

**Bootstrap (bucket-brigade ledger).** Claims (levers, measures) corroborate each other; independent confirmation raises status. Established is a threshold, not a feeling.

**Convergence (Thompson sampling).** When ≥1 measure is corroborated/established and ≥2 levers have ≥3 pulls, the governor activates: each lever carries a Beta(α,β) posterior; `strengthen` on converged rounds, `weaken` on flat ones. `bandit bandit` renders readiness and posteriors. Exploration is principled and vanishes as posteriors separate — the bandit *is* the annealing schedule.

## Budgets and safety

- **Card budget** is frontmatter (`budgetLimit`, `lifetimeTokensUsed`) — durable across restarts; an exhausted card refuses further runs.
- **Run budget**: per-run timeout + stall detection (0% CPU for 60s → kill). A hung agent is killed, not waited on.
- **Single-runner lock** (`run.lock`) with stale-lock auto-clear; a live lock makes the second `bandit start` a *visitor* — you join the running factory instead of doubling it.
- **Verification gate**: a card is only green when its reported command exits 0. Gate fingerprints make repeated identical failures visible.

## Recursion

A factory is a node. Child factories are spawned the way serfs are — folders with lineage:

```
.bandit/children/<name>/     # a full bandit node: own board, serfs, events, goal
```

Delegation flows down (a parent hands the child a scope: its `goal/` + initial cards); established truth flows up (ledger deltas as events). The parent's board sees only the child's *summary claims*, never its card traffic — attention is scoped by the tree. Overhead reduction is structural, not managerial.

## Invariants

1. One factory per project root per node — a tree may span many directories; each node locks only its own board.
2. Events are append-only; every state change is reconstructible.
3. Plumbing failures never punish the worker.
4. Budget is a hard stop; counters durable; budgets flow down the tree.
5. Verification runs in the declared container when one is set.
6. Never invent a control the harness didn't advertise.
7. If a feature can't be explained as "a file a serf reads or writes," it doesn't go in.