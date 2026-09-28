# Design — The KISS Ledger: what is, what's frozen, what's forbidden

Status: DESIGN — binding discipline for the loop's next phase
Date: 2026-09-28
Trigger: the principal's ruling — overfitting is the failure mode *before* floor-creep: every mechanism added this week was a reaction to one observed incident (n=1 fitting), and the machinery accreted three architectures in three days. Classic overfitting; KISS wins. This document is the regularization.

## 1. The rule (one line, load-bearing)

**No new mechanism without a measured trigger. A mechanism that has fired zero times in production is not evidence of need.**

This is not new doctrine — it is the design doc's own "build when triggered" column (§16.3), which we kept violating by building speculatively anyway. From now on the freeze column is enforced by review, not by enthusiasm.

## 2. What is (the kept set — each earned by a real failure)

| Mechanism | Earned by | Where |
|---|---|---|
| Event sourcing + card-as-folder | every board repair since v2 | protocol.md invariants 1, 7 |
| Budget caps (durable counters, hard stop) | plan-budget failures, Sep 11 | src/loop.ts recordSpend |
| The mechanical verify gate (self-verify, actual exit code) | gamed VERIFICATION_EXIT_CODE claims | src/runner.ts selfVerifyGateAsync |
| Transport-red guard (empty output → retry → red, critic never sees a placeholder) | 90 empty run files, 2026-09-24 | src/loop.ts transport guard |
| Format-leak repair for the grader (specific repairHint, not generic plumbing) | PAI-mode leak into serf lane | src/loop.ts parseCriticVerdict |
| Classifier seat (one cheap call, GRADER_PROMPT constant, `.bandit/grading/` track record) | replaces judge serf + critic-as-grader after the two-masters failure | src/loop.ts runCritic |
| Consult thread — three bounded points: plan, stagnation, no-convergence routing (DECISION line is the only parseable artifact) | the master↔addendum exchange being structurally impossible | src/loop.ts consultOnPlan / consultOnStagnation / routing |
| Plan file written by the loop from run output (never as a template var) | {{output.path}} shipped literally to the model | src/loop.ts runPlanPhase |
| Specialist spawn from the consult's verdict (regex counter only as plumbing fallback) | the stagnation conversation owning its own signal | src/loop.ts spawn trigger |
| renderPrompt literal-key precedence | {{actor.output}} never substituting | src/runner.ts renderPrompt |

Goodhart boundaries, restated once (they are the non-negotiables):
- **The gate is outside every conversation.** No consult, debate, or rebuttal turns a red gate green. `converged` requires `gate.green`.
- **The grader stays out of the room it grades.** The seat never participates in consults; the critic never grades; the master decides but cannot edit the gate.
- **Floors are not learnable by the optimizing organ.** If floors ever change, they change through the sanctioned path (evidence organs + human sign-off, §7 of the harness design), never through the policy that is scored by them.

## 3. What is frozen (the build-when-triggered column — now enforced)

| Frozen mechanism | Trigger that must fire in production first |
|---|---|
| Multi-turn debate (funnel: research turns, settlement judged by the seat) | a consult thread demonstrably changing an outcome — `consult.*` events correlated with convergence-rate delta over ≥10 fired consults |
| TD prediction of delayed rewards | staleness gap > P99 latency in >5% of decisions under load |
| Bandit Forest per objective | context features exist (TFD A2.2 world model) |
| MoE gating on reward weights | forest scores exist and are calibrated |
| Hierarchical credit (lever×expert×route) | joint learning is real, composites as independent arms until then |
| Held-out divergence channel (every N cards) | proxy-vs-true disagreement observed ≥2 times manually |
| Per-criterion structured seat (decomposed criterion grading) | grading disagreements with the gate ≥2 occurrences, logged | trigger MET 2026-09-28: `grader.gate_contradiction` fired 3× on one card (dogfood) — seat passed 0.98/0.95/0.9 while gate red. Unfreeze: seat must read the full artifact surface (actor output **+ consult.md** — the summon probe exposed that thread-lived acceptance criteria are invisible to grading) |
| Grader calibration loop (seat verdict vs eventual gate outcome) | enough grading records to compute agreement (≥20 cards) — the contradiction events above are the first 3 data points |

**Corollary — the anti-overfit rule for building:** every mechanism in §2 was preceded by a concrete incident. Nothing in §3 may be built because it would be *nice*, or because a paper recommends it, or because a repo does it. Deer-flow's restraint policy is the template: *"Sub-agents are an optimization, not the default response."* Mechanisms are optimizations, not the default response to complexity.

## 4. What was deleted today (scar tissue ledger)

- `CONSULT_MAX_TURNS` — declared, never enforced. Dead.
- `consultTurnCount` — counted `## consult:` headers that only one of three consult points ever wrote; silently misread the transcript. Dead.
- `judgeDir()` legacy fallback — a second architecture's remains; the critic must never serve grading. Dead.
- Unused `serfDirOverride` branch and `turnCount` field on `ConsultDecision`. Dead.
- (Prior passes, same rule: the judge serf, the DELIBERATION form contracts, the two-modes sketch, the three-organ split.)

Each deletion is itself evidence for the rule: three architectures in three days, each leaving sediment, is what n=1 fitting looks like in code.

## 5. The measure (how the freeze thaws)

Nothing in §3 thaw on argument alone. Each row's trigger is computed from events that already exist (`consult.*`, `critic.verdict` vs gate outcome, `decisions.*`). The refiner is the auditor: when a trigger's condition fires — e.g. ten consults logged and a measurable convergence delta — the row un-freezes and gets built. Until then the answer to "should we build X?" is: **what did it observe that §2's set couldn't handle?** No answer, no build.

One deliberate asymmetry: *deleting* has no trigger requirement. Scar tissue is removed on sight — the cost of carrying it compounds, the cost of re-adding a later-proven mechanism is one commit.