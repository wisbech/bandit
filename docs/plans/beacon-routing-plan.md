# Plan — Beacon (Jev) routing for bandit: evoke the right agent / folder / department

Status: DRAFT (for master/critic/principal review before any build)
Date: 2026-09-23 | Sources: [agent-beacon](https://github.com/Asymptote-Labs/agent-beacon) · [cross-harness memory docs](https://docs.beacon.sh/concepts/cross-harness-memory.md) · [detection engine](https://docs.beacon.sh/detections/engine.md) · local plan: `desk/plans/typesafe-integration-plan.md`

## 1. The problem this solves

Bandit's recursion is structural — child factories, specialist serfs, departments — but **routing is manual**. When a card lands, the loop runs `pipelineFor()` on shape (acceptance count, body length) and the master assigns by reading. Nothing answers the actual dispatch question:

> *Which folder, which serf, which child factory has the track record for THIS task?*

Beacon solves the adjacent problem with Jev (TypeSafe System One): a typed yes/no probability model that reads a bounded, redacted projection of an agent trace and returns scores — no text generation, no parsing. Beacon uses it to rank which traces contain reusable knowledge. The appropriation: use the same primitive to rank **which route a task should take**.

This matters more as bandit grows a tree of factories. A parent's board should not need to read a child's card traffic to delegate well (protocol.md: "attention is scoped by the tree") — it needs a *typed routing question answered by evidence*.

## 2. What Beacon actually does with Jev (the parts worth appropriating)

1. **Trace → bounded projection → typed questions → probabilities.** No LLM free-text. `Choice` (pick option), `Score` (spectrum position), `Noul` (probability true) — all batched in one ~2s call. Same primitives our desk plan already verified (typesafe-sdk 0.7.0, venv).
2. **Review-gated by design.** Jev probabilities rank and classify; they never *act*. Approval is explicit. "Jev may VETO; it may never create" — subtractive-only, fail-closed. This is exactly the safety philosophy already written into `typesafe-integration-plan.md`.
3. **Provenance stored with every score.** Evaluator model, usage metadata, source trace. A candidate that says "no lesson extracted" is honest rather than laundering scores into prose.
4. **Memory is local-first and project-scoped.** `memory.db` next to the runtime log; approved knowledge surfaces via MCP tools (`search_memory`) or generated Agent Skills.

## 3. Bandit's version: `beacon routing` (working name)

Not Beacon-the-product — the *pattern*: typed probability questions over typed state, stored with provenance, consumed by the factory's own routing decisions.

### 3.1 What we build

**A. Route ledger (bandit-native, exists already in embryo).**
The confidence ledger already stores per-lever posteriors. Add a **route record** per serf/folder/child-factory: kind (serf | specialist | child-factory), scope tags, and the same Beta(α,β) posterior bandit's governor uses for levers. A serf that converges cards tagged `python`, `backtest`, `energy` accrues α on those tags; a serf that fails them accrues β.

**B. Task typing via Jev (the Beacon move).**
When a card enters the board, one batched Jev call over the card body (bounded, redacted — same discipline as Beacon's trace projection):

| Primitive | Question | Elicits |
|---|---|---|
| Choice | "Is this task primarily: build / review / research / ops / writing?" | folder/department route |
| Score | "How much does this need prior repo context, 0–4?" | serf vs child-factory (context-heavy → the child that owns the repo) |
| Noul | "Does this task match the scope of factory `<X>`?" (one per candidate child) | recursion gate — delegate down or run local |

All questions run in parallel against one state in a single call. Cost stays flat per card.

**C. Provenance on every routing event.**
`emit("card.routed", { card, route: "specialists/typesafe-…", scores: {...}, evaluator: "jev-latest", source: "live" | "fail_closed" | "disabled" })`. A route chosen with `source: "disabled"` is just `pipelineFor()` as today — Jev removed changes nothing, the desk still runs. Subtract-only by construction.

### 3.2 Safety philosophy (lifted verbatim from the desk plan, because it's already right)

1. **Subtractive-only**: Jev may *bias routing*; it may never create cards, spawn serfs on its own, or override the master's explicit assignment.
2. **Fail-closed**: API error, timeout (10s), malformed response ⇒ route via the existing shape-based default. Never block a card from being processed.
3. **Ledger untouched**: Thompson sampling over actual convergence outcomes remains the governor of *track records*; Jev is an additional signal at dispatch time, never a replacement.
4. **Bounded state**: the projection sent for evaluation contains the card body only — never serf memory, never other boards' traffic.
5. **Provenance or it didn't happen**: every Jev-influenced decision stores evaluator, model, question set, and the probabilities — inspectable in the event log like everything else.

### 3.3 Where it plugs in (small surface)

- `src/routing.ts` — new module: `buildTaskState(card) -> str`, `assessRoute(card, candidates, client?) -> RouteAssessment`, `routeCard(assessment) -> route | null`. Pure functions + injected client seam for mocking (mirror of `typesafe_gate.py` design, already critic-approved in shape on the desk).
- `loop.ts` — one call site: after `pipelineFor()`, if `cfg.routing` configured and Jev reachable, call `assessRoute`; on veto/failure fall through to current behavior.
- `bandit routing` — CLI: show route posteriors per serf/folder, last N routing events, Jev health (like `bandit bandit` renders the governor).
- Config: `"routing": { "command": "...", "endpoint": "...", "model": "jev-latest", "enabled": true }` in `config.json` — one profile, same shape as `reducer`.

### 3.4 What we explicitly do NOT appropriate

- **Beacon's trace capture** (20-harness OTLP collection): bandit's event log already *is* the trace, normalized, local-first, append-only. Adding a second capture layer is duplication.
- **Review-gated memory promotion**: bandit's refiner + critic already gate memory writes with evidence and snapshots. Beacon's `memory.db` review queue solves a problem bandit solved differently (and we keep rollback).
- **Managed/forwarding/SIEM**: not our threat model.

### 3.5 Sequencing

| Phase | Deliverable | Gate |
|---|---|---|
| P0 | Route ledger schema (extend confidence ledger; serf folders get `routing.json`) | no Jev calls; pure folder state |
| 1 | `assessRoute` with mock client + tests; Choice/Score/Noul pinned shapes | mocked only; loop untouched |
| 2 | Live Jev via typesafe-sdk in `~/Downloads/7N` factory (the desk already has the SDK + key) | `card.routed` events with provenance; compare routing vs master's manual assignments for 2 weeks of cards |
| 3 | Loop integration behind `routing.enabled`; fail-closed default | a/b: routed vs `pipelineFor()`-only; capability unchanged (cards still converge), efficiency = fewer specialist misroutes |
| 4 | Cross-factory: parent factories consult children's route ledgers before delegation (protocol.md's "established truth flows up" gets a dispatch-time complement) | parent never reads child card traffic — only route records flow up |

### 3.6 Success metric (bandit-native, not Beacon's)

Beacon measures token efficiency. Bandit's routing question is narrower: **fraction of cards that reached convergence *without* a specialist-spawn or review-escalation**, routed by Jev vs the shape-only baseline. If subtractive routing doesn't reduce misroutes, the flag goes off and we keep the simpler machine — same discipline as the desk.

## 4. References

- [Asymptote-Labs/agent-beacon](https://github.com/Asymptote-Labs/agent-beacon) — trace + reviewed-memory layer; the Jev evaluation workflow
- [Cross-Harness Memory docs](https://docs.beacon.sh/concepts/cross-harness-memory.md) — the review-gated loop, storage scope, privacy boundary
- [Detection engine docs](https://docs.beacon.sh/detections/engine.md) — rules-over-ordered-events; the `oracle_waste` refiner class could later run as detection YAML against bandit's own event log
- [TypeSafe Jev / System One](https://typesafe.dev) — typed questions, probabilities, no rationale (the desk plan §1 documents the primitives)
- Local prior art: `desk/plans/typesafe-integration-plan.md` (safety philosophy, fail-closed wrapper, SDK 0.7.0 quirks)
- This appropriation joins [docs/appropriations.md](appropriations.md) if built.

## 5. Open questions for master/critic

1. Should route records live in the confidence ledger (lever-like, Thompson-sampled) or a separate `routing.json`? *(Leaning: ledger — same data shape, one governor.)*
2. Is Jev dispatch-time worth it at all below ~5 cards/day, or is shape-routing + master reading enough until the tree is 3+ factories deep? *(My lean: P0–P1 are nearly free and inform P2; P2 is the real decision point.)*
3. Does the critic get a standing veto on routes (subtractive-only, consistent with the desk) or only on cards? *(Lean: standing veto — it's the same gate we trust for work.)*