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
- [Jev Engineering for Coding Agents — working note (Almeida synthesis)](https://drive.google.com/file/d/17h982xvsL3E7b80iGmOCfKp9qTOW9ohv/view) — the no-KV-cache design question, the routing trap, retrieval dominance, visibility ladder (reviewed in §6.1)
- [Skill2Env (NVIDIA)](https://github.com/NVlabs/Skill2Env/blob/main/paper/Skill2Env_arXiv.pdf) — Oracle/NOP environment acceptance, rubric-vs-tests separation (reviewed in §6.2)
- [Self-Organizing Agent Teams (Stanford/Together)](https://arxiv.org/html/2609.22682v1) — routing-oracle baseline, demonstrability, frozen strategy banks (reviewed in §6.3)
- Local prior art: `desk/plans/typesafe-integration-plan.md` (safety philosophy, fail-closed wrapper, SDK 0.7.0 quirks)
- This appropriation joins [docs/appropriations.md](appropriations.md) if built.

## 5. Open questions for master/critic

1. Should route records live in the confidence ledger (lever-like, Thompson-sampled) or a separate `routing.json`? *(Leaning: ledger — same data shape, one governor.)*
2. Is Jev dispatch-time worth it at all below ~5 cards/day, or is shape-routing + master reading enough until the tree is 3+ factories deep? *(My lean: P0–P1 are nearly free and inform P2; P2 is the real decision point.)*
3. Does the critic get a standing veto on routes (subtractive-only, consistent with the desk) or only on cards? *(Lean: standing veto — it's the same gate we trust for work.)*

---

## 6. Evaluation update — deeper background review (2026-09-23)

Three additional sources reviewed before any build. **Verdict up front: the original plan survives, but it was aimed at the wrong-sized target. The evidence reorders our priorities.**

### 6.1 The Jev Engineering notes (Almeida/TypeSafe synthesis, 12pp working note)

*Source: [Google Drive working note](https://drive.google.com/file/d/17h982xvsL3E7b80iGmOCfKp9qTOW9ohv/view)*

The note's organizing question — *how would you design a coding agent if LLMs had no KV cache?* — reframes everything. Six "symptoms of the KV cache" that agents inherit unexamined. The two findings that touch bandit directly:

- **The routing trap (§III-A):** mixed-model routes lose money *because of context transport*, not token price. Their worked example: Opus→Sonnet→Opus costs 6.19 vs 4.15 for pure Opus on a plausible session shape — the "cheap" route costs ~⅓ more. **This directly challenges our plan's P2**: if a child factory needs the parent's context reloaded, Jev-routed delegation can cost *more* than local execution. Bandit is actually structurally advantaged here — cards are purpose-built contexts by construction — but the plan never priced the return trip. **Revision: routing decisions must be priced per-context-rebuild, not per-token. The route ledger must record context-size deltas, not just outcomes.**
- **Retrieval dominates (§III):** reading/searching/command output ≈ two-thirds of processed tokens; writing < 10%. Bandit's biggest efficiency lever isn't compaction — it's *not loading what isn't needed*. Our ObservationPack + round digests already push this way; the visibility-ladder idea (per-query visibility: hide/short/long/full) is a stronger framing than our fixed excerpt. **Appropriation candidate: the ladder, at the next critic-input iteration.**
- **Programmable permissions as policy code** (deny if touches `.env*`, ask if writes outside repo root) — bandit's verification gate could adopt this shape cheaply. Note only; the gate already does the heavy lifting.
- **Skill tiered disclosure** (snippet-first, full schema on demand) — relevant to how bandit serfs discover each other later; park it.

### 6.2 Skill2Env (NVIDIA)

*Source: [paper PDF](https://github.com/NVlabs/Skill2Env/blob/main/paper/Skill2Env_arXiv.pdf)* — turns public Agent Skills into 8k executable environments with programmatic tests + behavioral rubrics, then RLs on them.

This is an RL-training recipe; nothing in bandit trains weights. But two verification disciplines are directly appropriable:

- **Oracle/NOP acceptance**: a candidate environment is accepted only if the oracle test passes on the reference solution AND fails on a no-op (NOP). *A verifier that passes on nothing verifies nothing.* Bandit's analogue: a card whose verification command passes without the actor doing anything is a broken card. **Appropriation: gate-fingerprint the empty state — if a card's verification command is green on the untouched repo, flag `verification.vacuous` and route to review.** This closes a fabrication path the self-verify gate doesn't cover: the *pre-passing* gate.
- **Rubric ≠ tests**: separate verifiable correctness (tests) from procedural quality (Must-do / Must-avoid / Best-practice rubric). Bandit cards conflate these. **Appropriation candidate: optional `## Rubric` section consumed by the critic as structured review dimensions.**

### 6.3 Self-Organizing Agent Teams (Stanford/Together)

*Source: [arXiv 2609.22682](https://arxiv.org/html/2609.22682v1)* — fixed agent teams learn reusable teamwork strategies (roles, phases, information flow) offline; frozen banks transfer; teams beat a perfect routing oracle on math/physics (66.7% vs 59.0%).

Three findings matter to bandit's roadmap:

1. **Routing oracle as the honest baseline.** They refuse to credit a team for "gains" a perfect per-problem selector over members' independent answers would achieve. Bandit's planned Jev routing must be measured the same way: does Jev routing beat a *perfect selector over serf track records*? If not, the ledger alone (Thompson over outcomes) already achieves selection — Jev is only earning its keep if it predicts *before* the track record exists. **This sharpens the plan's success metric.**
2. **Demonstrability predicts when collaboration pays (ρ=0.90).** Teams improve most where correct reasoning is *recognizable* — which is exactly the critic's job. Bandit's convergence gate (critic + verification) is a demonstrability machine. Implication: bandit's multi-serf structure pays most on cards where correctness is checkable — reinforcing verification-gated cards over open-ended ones. No build action; a portfolio-guidance insight.
3. **Organization as a learned, frozen artifact** (strategy banks, problem-independence audits, coverage-greedy selection) is the same shape as bandit's refiner + confidence ledger: propose with evidence, validate on probes, freeze, transfer. Their "source-dependence audit" (rejecting candidates that encode source-specific content) maps to the refiner's evidence requirement. Validation, not novelty.

### 6.4 Updated verdict

| Original plan element | Verdict after review |
|---|---|
| Jev-routed card dispatch (P2) | **Weakened** — the routing-trap math says dispatch is only cheap when contexts are purpose-built (cards are) but return-trip pricing was missing. Demote to experiment-with-oracle-control: Jev routing must beat a track-record selector, not just `pipelineFor()`. |
| Route ledger (P0) | **Strengthened** — SAT's routing-oracle lens makes the track-record ledger the reference implementation against which any Jev dispatch must prove itself. |
| Provenance, subtract-only, fail-closed | **Unchanged** — all three sources reinforce this as the load-bearing discipline. |
| Vacuous-gate check (new, from Skill2Env Oracle/NOP) | **New P0.5 item** — cheap, closes a real hole, no Jev dependency. |
| Rubric section on cards (new, from Skill2Env) | **Backlog** — helps the critic; low priority. |
| Visibility ladder for critic input (new, from Jev notes) | **Backlog** — stronger framing than fixed excerpts; do when token math justifies. |

**Recommendation:** proceed with P0 (route ledger) and add the vacuous-gate check immediately (it's an afternoon, closes a real hole). Hold P2 until the route ledger has enough history to answer the routing-oracle question with bandit's own data. Jev earns its way in only if it beats the ledger selector on *new* cards — that's now a testable claim rather than an assumption.