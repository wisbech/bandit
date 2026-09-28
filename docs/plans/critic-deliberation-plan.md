# Plan — Critic as peer: the consult model (grading = classifier, conversation = default)

Status: DESIGN v3 (supersedes the three-organs structure after the principal's deer-flow correction)
Date: 2026-09-28
Trigger chain: (1) the master↔addendum exchange is the best output this project produced and was structurally impossible in the loop; (2) v2's three-organ fix was rejected as "bloated bureaucracy in digital suit" — two grading organs (judge jev-style, critic LLM-style) doing the same job, and the master handed a committee it can only address through forms; (3) the deer-flow pattern validates the alternative: **one lead agent in conversation, with a peer available at hand, and grading as a cheap classifier function — not a persona.**

## 0. The deer-flow correction (adopted)

DeerFlow 2.0's architecture: a single lead-agent graph; sub-agents spawned on demand only when "delegation has clear net benefit" — parallel latency, specialist capability, context isolation; **"Sub-agents are an optimization, not the default response"**; verification is the lead's job; the only standing checks are deterministic (tool receipts, loop detection). No supervisor, no standing critic committee. Bandit's lesson, translated:

- The **loop** (bandit's irreplaceable part) stays: cards, events, budgets, the mechanical verify gate, the confidence ledger. This is the factory floor — deer-flow has no equivalent and needs none at its scale.
- The **conversation** is what was missing: the master should be able to *talk to the critic* the way the principal talked to the harness — threaded, plain text, from the moment a problem opens. Forms only where the loop must parse a decision.

## 1. What stays, what dies, what changes

**Dies:**
- **JUDGE as a serf.** The principal is right — a judge is a jev classifier, not an agent. Grading becomes a *seat*, not a role: when the decisions port is configured, the port answers (graded, per-criterion — the real implementation); when not, one cheap LLM call through the existing `parseCriticVerdict` protocol (the fallback classifier seat). No `serfs/judge/` folder, no persona, no identity file. v2's judge/critic split collapsed into: classifier seat (function) + critic (peer).
- **The VERDICT-form deliberation exchange.** The actor's rebuttal and the critic's amendment become free text in the consult thread — the loop only needs the final state, which is the *consult verdict* (below), not five format contracts.
- **"Critic plumbing" as an actor-facing event storm** stays exactly as-is (it is the one part of the GAN that worked) — but it applies to the classifier seat only.

**Stays (unchanged):**
- The mechanical verify gate as the Goodhart boundary — no conversation touches red/green.
- Convergence composition: `gate.green AND (grading pass | plumbing-bypass | fail ≤ 0.7 confidence)`.
- The `deliberation.md` transcript (renamed `consult.md`), specialist triggers, budgets, events.

**Changes:**
- **CRITIC becomes the master's peer, present from problem-start.** Three consult points, all threaded into one per-card transcript (`card/consult.md`), all plain text, all budget-counted:
  1. **Plan time** (non-trivial cards): the master shows the plan to the critic *as a peer* — "here is the plan, argue it" — before execution tokens burn. The critic answers free text; the master decides. The old `plan.rejected` one-way form dies: a rejected plan is now a *conversation* the master had, and the plan goes back amended, not just rejected.
  2. **Stagnation**: gate unchanged twice (`unchangedGate`) or the same missing capability cited twice — the master consults mid-flight instead of spawning a specialist on a regex. The specialist spawn becomes *one possible outcome* of the consult, not a separate mechanism.
  3. **No-convergence**: the existing consult, now threaded with full history instead of a cold prompt.
- **MASTER owns the conversation; the loop referees it.** Consult turns are `runSerfReply` exchanges appended to `consult.md`; every exchange emits `consult.turn { card, thread, by }` so the events log stays the audit trail. Bounded: ≤2 turns per consult point, ≤3 consult points per card.

## 2. The classifier seat (replacing both the judge serf and the critic-as-grader)

```
grade(card, output):
  if decisions port configured → port answers (graded per-criterion probabilities)
  else → one headless call, prompt = judge-classifier template, parse VERDICT/CONFIDENCE/REASONING
```
- The seat has **no serf folder** — its prompt is a constant in `loop.ts` (grading is a function, and functions don't have identities).
- Cheap-tier routing (the reducer model from LoopConfig) when configured — the "expensive judge" cost complaint, answered.
- Track record still persists (`.bandit/grading/<card>.md`) — calibration data for the refiner, no persona to be infected.

## 3. The consult thread (the master's conversation at hand)

`consult.md` shape — plain text, threaded, the way the principal and the addendum actually talked:

```
## consult: plan — 2026-09-28T08:00Z
master: <the plan + the master's own concern, free text>
critic: <argument, free text — be convincable; the master decides>
master: <decision: proceed | amend (with what) | reject (why)>
```

Rules:
- The master's decision line is the only parseable artifact (`DECISION: proceed|amend|reject|specialist: <capability>`) — one line, everything else free.
- The critic is instructed as a peer: "Argue hard when you disagree, concede when answered. The master decides; your job is that the decision is made with your best argument in the room — from the start, not after the failure."
- Stagnation consult reuses the same thread: the master pastes the two identical gate fingerprints and asks "same wall or different wall?" — the specialist spawn decision falls out of the conversation instead of a regex counter.

## 4. Decision table (v3)

| Build now | Build when triggered | Forbidden |
|---|---|---|
| classifier seat (port → cheap LLM fallback), no judge serf | graded per-criterion probabilities in the seat when the port earns it | a second grading persona; grader prompts with identity |
| consult thread at plan time (critic as peer, master decides) | critic-initiated consult (critic flags a plan risk unprompted) if ROI shows | consult on trivial pipelines (cost discipline) |
| stagnation consult replacing the regex specialist trigger | multi-critic consult (a second perspective) if single-critic misses recur | unbounded threads (≤2 turns/point, ≤3 points/card); any consult touching the gate |
| no-convergence consult (threaded, replaces the one-shot ROUTE form) | consult transcript feeding the refiner's criterion generation | forms for conversation; conversation for measurement |

## 5. Why this is the deer-flow lesson, in bandit's vocabulary

Deer-flow: one lead agent, help spawned on clear net benefit, deterministic checks everywhere else. Bandit after this change: one master in conversation with a peer critic (present at problem-start, not post-mortem), grading as a classifier function (cheap, calibrated, no persona), the mechanical gate as the one thing no conversation can move. The committee dissolves; the factory floor — cards, events, budgets, ledger — stays.

## 6. Cost

Consults only at measured points (plan, stagnation, no-convergence), ≤6 reply turns per card worst-case, budget-counted. The classifier seat is one cheap call per round (cheaper than the serf run it replaces: no identity render, no folder I/O). If `consult.*` events show no convergence benefit over ~10 firings, the thread dies like every speculative mechanism here — evidence-gated, snapshot-backed, reversible.