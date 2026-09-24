# Plan — Expert evocation: consult, then spawn (the expert registry)

Status: DRAFT (master/critic review) · Date: 2026-09-24
Depends on: [decisions port](../../src/decisions.ts) (implemented) · [beacon-routing-plan.md](beacon-routing-plan.md) (route ledger) · [icm-workspace-plan.md](icm-workspace-plan.md) (Layer 3 reference material)

## 0. TL;DR

When the master builds something, bandit should **evoke an existing expert** — a serf, an ICM reference collection, a domain-knowledge folder in the project — and if none exists, **spawn one: researched and designed before it works**. The pieces exist in fragments: `registerChild()` spawns folders with lineage, the route ledger tracks outcomes, `Knowledge/` holds domain material (e.g. Sinclair's volatility trading). What's missing is the **expert registry** that makes "who should master consult?" answerable, and the **evocation flow** that turns a card into a consult before code is written.

The design principle, stated as an invariant: **expertise is a file a serf reads** — evocable by reference, spawnable when absent, recorded in the ledger either way.

---

## 1. The three tiers of expertise (what "evoke someone" means mechanically)

| Tier | What it is | Where it lives | Invocation |
|---|---|---|---|
| **T1: Expert serf** | A serf folder with domain prompt + track record (e.g. a `quant` serf that has converged 5 vol-targeting cards) | `.bandit/serfs/<role>/` | Master's card names it; loop runs it as a consultation turn |
| **T2: Expert corpus** | ICM Layer-3 reference material — a book, a strategy canon, a design system (e.g. `Knowledge/Trading/sinclair-volatility-trading.md`) | project `references/` or `Knowledge/` | Routed into the actor's prompt via the card's Inputs table (the ICM appropriation) |
| **T3: Spawned specialist** — nothing existing fits; an expert is *created*: researched (web/wiki), designed (prompt + scope + acceptance), registered with lineage | `.bandit/serfs/specialists/<name>/` | `registerChild` + a research phase before first use |

The user's requirement maps exactly: **consult T1/T2 if found; spawn T3 if not** — and the spawning must itself be *researched and designed*, not a fresh generic serf.

## 2. The expert registry (`bandit experts`)

A registry file per factory: `.bandit/experts.json` — the routing question "who knows about X?" made explicit and inspectable.

```json
{
  "experts": [
    {
      "name": "quant-vol",
      "kind": "serf",
      "domain": ["volatility", "sizing", "vol-targeting", "drawdown"],
      "prompt": ".bandit/serfs/specialists/quant-vol/prompt.md",
      "provenance": "spawned 2026-09-24, researched: Sinclair chapters 1-4, tastytrade research",
      "ledger": { "pulls": 5, "corroborations": 3 }
    },
    {
      "name": "sinclair-volatility",
      "kind": "corpus",
      "domain": ["volatility", "var-swap", "realized-vol"],
      "path": "Knowledge/Trading/sinclair-volatility-trading.md",
      "loadBudget": 2000
    }
  ]
}
```

- **Two kinds**: `serf` (a consultable agent) and `corpus` (reference material routed into a prompt — Layer 3). Both answer "who should master talk to about X"
- **Track record flows from the ledger** — the same Beta posteriors the governor uses. An expert that consulted on converged cards earns α; consultations followed by failures earn β. Experts are *measured*, not decorative
- `bandit experts` renders it; `bandit experts add <name> --corpus <path> --domain a,b` / `--serf` register

## 3. The evocation flow (in the loop, at plan time)

Where it plugs in: **after `pipelineFor()`, before round 1** — the same boundary as the card-intake critique. One flow, three steps:

```
card enters → pipelineFor → INTAKE (critic: ambiguous/impossible?)
  → EXPERT EVOCATION:
      1. match card topic ↔ expert registry domains (typed question:
         decision port choice, or ledger-domain overlap — no LLM needed
         for exact tag matches)
      2. T1 hit  → consultation turn: expert serf reviews the card +
         plan, answers in its domain vocabulary, output lands in
         card/consultations/<expert>.md and is cited by the actor
      3. T2 hit → corpus routed into the card's Inputs table (ICM Layer 3)
      4. NO HIT → SPAWN:
         a. research phase (watcher/web): gather the domain's vocabulary,
            canonical references, failure modes
         b. design: prompt.md with domain persona + boundaries +
            acceptance vocabulary; serf.md identity; registered in
            experts registry + children lineage
         c. first consultation = its audition (verdict recorded)
  → actor round 1 runs WITH the consult in hand
```

The spawn discipline (from the existing specialist mechanism, hardened):
- A spawned expert **must have a researched prompt** — the research step is not optional; a generic "you are an expert in X" serf is the thing this exists to prevent
- Spawned experts start at the prior (weak, pessimistic — PRIOR_BETA=2 in bandit.ts) and earn standing exactly like levers
- Every evocation emits `expert.consulted { card, expert, kind, verdict }` / `expert.spawned { expert, research: <paths> }` — provenance or it didn't happen

## 4. Who does the evoking (division of labor)

- **The master proposes** the expert need (it knows what it's building — "I need options-pricing expertise for card 010") — its proposal is a field on the card or a consult request, not a side-channel
- **The loop resolves** registry → consult / spawn mechanically
- **The critic reviews the consult** as part of intake: a consult that says "criteria are impossible" rewrites the card before the actor runs — the critic's pre-build voice, which it just told us it lacks
- **The researcher serf grows the corpus** (see §5.1): knowledge added with sources becomes corpus experts; the human audits provenance, the ledger measures usefulness

## 5. What this is NOT

- Not a chat pane per expert — consultations are headless turns whose artifacts land in the card folder (the 7N lesson: pane conversation is ledger-blind)
- Not auto-hiring: the master can't spam-spawn experts. Spawn budget counts against the card's budget; one spawned expert per missing-domain per card, dedup by registry
- Not ICM-only: the registry reads project folders AND `.bandit/serfs/` — "existing or spawn" is the T1/T2/T3 fallback order, mechanically enforced

## 5.1 The registry is emergent, not designed (correction, 2026-09-24)

An earlier draft had the principal pre-registering experts at configuration time. **That is the top-down reflex bandit exists to replace.** The registry must be:

- **Born from need**: a spawn is triggered by an actual routing gap — a card with no domain match in the registry, or a repeated failure citing the same missing expertise (the existing specialist trigger). No gap, no spawn.
- **Designed by the research step, not by decree**: the spawned expert's prompt is *written from the research it gathered* (domain vocabulary, canonical references, failure modes) — the design is a product of the research phase, and the research paths are its provenance.
- **Pruned by the ledger**: experts that consult repeatedly without improving convergence outcomes decay to `dead` exactly like levers — the registry is a projection of measured usefulness, not a roster someone maintains.
- **Evolving toward the goal**: as the goal sharpens (the goal.md is fixed; the *path* to it is discovered), the domains the factory needs change. The refiner reads the event log for consult patterns — repeated escalations in a domain with no expert = the emergent signal that the next expert should be spawned. The registry follows the goal; it is never ahead of it.

**What the human DOES own**: the *initial* corpus — what knowledge exists in the project at setup (`references/`, `Knowledge/`) is a fact about the project. But the corpus is not frozen: **a researcher serf can grow it.** The watcher/research lane already fetches briefs; its citations, distilled patterns, and validated references belong in the corpus too — written as files, cited with sources, and registered as corpus experts when they prove consultable. The boundary that matters is not "human writes, serfs read" — it's **evidence-gated growth**: corpus additions from researcher serfs carry sources (URL + timestamp, the watcher's existing discipline), land as files, and the refiner promotes frequently-cited additions into the registry. The factory grows what it knows; the ledger measures what it learned; the human audits the provenance.

## 6. Sequencing

| Phase | Deliverable | Gate |
|---|---|---|
| E0 | Expert registry schema + `bandit experts` list/add + T1 corpus routing via card Inputs tables | registry read-only; no consult calls |
| E1 | Consultation turn: expert serf answers into `card/consults/`; actor prompt cites it | one pilot card in a live factory — consult artifact + critic intake both reference it |
| E2 | Spawn flow: research step (watcher + web) → designed prompt → registry + lineage | spawned expert's first consult passes critic review |
| E3 | Track-record wiring: consult outcomes strengthen/weaken expert posteriors; routing prefers measured experts | expert selection beats round-robin on consult usefulness |

## 7. Open questions for master/critic

1. Who researches a spawned expert — the watcher serf (news lane) or a dedicated research turn? *(Lean: watcher — it's already the research surface; keeps one nervous system.)*
2. Do corpus experts (T2) get measured, or only serf experts? *(Lean: corpus "experts" get usage counts, not posteriors — you measure the consultant, not the book.)*
3. Should the intake critique and expert evocation be one combined pre-build phase? *(Lean: yes — one boundary, two questions: "is this card possible?" and "who should we hear first?" — it's the critic's intake voice plus the master's staffing need in one pass.)*

## 8. References

- Existing spawn machinery: `registerChild` in [src/bandit.ts](../../src/bandit.ts) — lineage folders, children registries
- [beacon-routing-plan.md](beacon-routing-plan.md) — route ledger; experts join it as route targets
- [icm-workspace-plan.md](icm-workspace-plan.md) — Layer 3 reference routing; the Inputs table
- [SAT](https://arxiv.org/html/2609.22682v1) — the roster is fixed; *roles are learned* — an expert registry is bandit's role bank
- [docs/appropriations.md](../appropriations.md) — entry added if built
- Example corpus (project-side fact, not bandit content): a factory with `Knowledge/Trading/sinclair-volatility-trading.md` would register it as a T2 corpus expert — discovered by scanning project reference folders, not by hand