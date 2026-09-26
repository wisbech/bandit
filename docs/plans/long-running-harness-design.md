# Design — Long-running bandit harness (Goodhart-resistant governor)

Status: DESIGN (map-then-build; answers the spec's open questions in bandit's vocabulary)
Date: 2026-09-25
Spec source: the long-running bandit harness task (Karwowski et al. 2023, Gao et al. 2023, Kwa et al. 2024, CARMO, DORB, EST, Udemy engineering)
Existing machinery: [src/bandit.ts](../../src/bandit.ts) (Thompson governor), [src/confidence.ts](../../src/confidence.ts) (ledger), [src/decisions.ts](../../src/decisions.ts) (decision port), [src/loop.ts](../../src/loop.ts) (convergence rounds)

## 0. The core mapping — this spec is bandit's governor with named gaps

The task describes a stateful bandit over K arms with a true objective, proxy metrics that go stale, divergence monitoring, and criterion retirement. **Bandit already is that system** — with different vocabulary and three honest gaps:

| Spec requirement | Bandit equivalent today | Status |
|---|---|---|
| 1. State persistence (restart-safe) | `.bandit/goal/bandit.jsonl` (append-only posteriors), `confidence.jsonl` (ledger), `run.lock` w/ stale-clear | **Exists** — event-sourced; no Redis needed |
| 2. Non-stationarity | `decay` per cycle (DECAY_FACTOR 0.98), `updateOnFlat` soft decay | **Exists (γ-style)** — see §3 for why sliding window is the wrong shape here |
| 3. Delayed rewards | Card outcomes resolve when the loop converges the card (async by construction; loop is the join) | **Exists, misframed** — see §4 |
| 4. Multi-objective reward VECTOR | `goal.md` convergence definition = 4 clauses (CAGR primary, DD floor, Sharpe, robustness) | **Exists as text; NOT mechanical** — biggest real gap → §5 |
| 5. Divergence monitor (held-out ≥2%) | **MISSING** — nothing scores proxy-vs-true independently | **Build** → §6 |
| 6. Adaptive criteria (retire/promote, generator independent of policy) | Critic verdicts + refiner (evidence-gated) — *close but the retirement trigger isn't divergence-driven* | **Partially exists** → §7 |
| 7. Exploration floor | Thompson sampling never zeroes an arm's posterior — but no *hard floor*; converged factories stop touching weak levers | **Build** → §8 |
| 8. Reward capping | `recordSpend` budget counters exist; reward scalars uncapped | **Build** → §9 |

Anti-goals check: bandit never optimizes a single scalar (the ledger is per-claim, the goal is multi-clause), criteria come from the critic + refiner (independent of the actor policy), no fixed schedule (divergence/plateau triggers — matches), proxies expire (decay does this). The spec's anti-goals are bandit's invariants restated — good sign we're building the same machine.

---

## 1. Open questions, answered in bandit's vocabulary

**Reward latency distribution (P50, P99):** A card's "reward" (converged/not) lands when its convergence rounds finish: P50 ≈ 2–6 min (one round, green gate), P99 ≈ 15 min (3 rounds + specialist spawn) per card. For cross-card signals (a lever's payoff), latency = until ≥2 corroborating cards resolve: hours to days. The join mechanism is the card folder itself (outputs + verdicts + gates.json land as files; the loop reads its own card at each boundary — no external queue).

**Arm count and change:** Arms = levers (strategy variants, config axes) + experts (serfs) + routes. Today TFD has 1–2 live levers; the Sosnoff track adds ~4 (per-strategy) + the universe choice. Arms ARE added/retired over time — spawned by convergence failures, retired by the ledger (`retired` events exist). The harness must handle a changing arm set: Thompson sampling over posteriors handles this natively (new arm = fresh prior).

**The true objective, operationally:** `goal.md` *is* the spec's "TRUE objective" — and bandit's design already isolates it: fixed at setup, never edited by the optimizing policy (protocol.md invariant #2: base protocol immutable). Who scores it: (a) the verify suite (mechanical clauses: cost stress, jitter, look-ahead), (b) the critic (judgment clauses: evidence standards), (c) the decisions port (demonstrability probability — the Laya/Jev evaluator, fail-closed). The held-out channel (§6) adds the missing independent scorer.

**Cost of a wrong decision:** For TFD: a bad arm pull = one wasted card run (bounded by budget caps — cheap); a *gamed* arm winning long-term = the desk trades a fragile edge (bounded by the kill switch — expensive but survivable). This asymmetry says: **aggressive exploration floor is affordable** (wrong pulls are cheap); **divergence detection must be fast** (gamed winners are the real risk). p_min = 5% is affordable; divergence alert latency target = 3 cards.

---

## 2. Architecture: the governor grows the missing organs

```
                    ┌────────────────────────────────────────────┐
                    │              .bandit/goal/                 │
                    │  goal.md (TRUE objective — fixed)          │
                    │  bandit.jsonl (posteriors — the policy)    │
                    │  ledger (claims, corroboration)            │
                    │  criteria.jsonl (rubrics + provenance)     │
                    │  heldout/ (the ≥2% channel)                │
                    └────────────────────────────────────────────┘
                         ▲              ▲               ▲
        reward vector    │              │               │  divergence alert
        (multi-clause)   │              │               │  (proxy ↔ true gap)
              ┌──────────┘              │               └──────────────┐
        ┌─────┴─────┐            ┌──────┴──────┐              ┌───────┴──────┐
        │ CONVERGE  │            │   EXPLORE   │              │   AUDIT      │
        │ gate+critic│           │ floor p_min │              │ held-out run │
        │ vector→α/β │           │ Thompson on │              │ every N cards│
        └───────────┘            │  posterior  │              └──────────────┘
                                 └─────────────┘                     │
                                                       ┌─────────────┴─────────┐
                                                       │ retire criterion      │
                                                       │ promote next frontier │
                                                       │ log transition        │
                                                       └───────────────────────┘
```

## 3. Non-stationarity: keep γ-decay, reject sliding window

Chosen: **discounted updates** (existing DECAY_FACTOR 0.98/cycle + updateOnFlat's 0.9 α-decay), because bandit's observations are *expensive, low-volume, and corroborated* — a sliding window W would need W large enough to matter statistically (W ≥ 20) which doubles state volume for a system whose entire point is a small auditable ledger. Discounting is the honest fit: old evidence never vanishes, it just stops dominating.

**Addition:** decay rate becomes per-lever configurable in the posterior line (`decay: 0.98`), so a lever in a fast-moving domain (news-driven watcher signals) can decay faster than one in a stable domain (settlement mechanics).

## 4. Delayed rewards: the card folder IS the join

No Kafka. The spec's join problem (reward arrives minutes later, match it to the action) is solved by **event sourcing with the card as the correlation key**: every run, verdict, gate, and consult lands in `card/outputs/` keyed by card id; the loop joins at round boundaries; the ledger joins at card completion. A reward that "never arrives" = a card stuck in `in-progress/` — visible, budget-capped, and resumable (frontier scan). The P99 tail (specialist spawn chains) is bounded by maxRetries + budget exhaustion.

What this buys vs the spec's queue design: the state is *files a human can read*. The Udemy reference's Kafka+Redis architecture exists for >10k events/hour; bandit's volume (tens of cards/day) would be architecture cosplay.

## 5. Reward vector (requirement 4) — make goal.md mechanical

**Build: `goal-vector.jsonl`** — the goal's clauses become weighted, versioned, runtime-configurable criteria:

```json
{"criterion":"oos_cagr","weight":0.4,"floor":null,"source":"backtest-oos","v":3}
{"criterion":"max_drawdown_le_20","weight":0.3,"floor":0.20,"source":"backtest-oos","v":3}
{"criterion":"sharpe_ge_1_net","weight":0.2,"floor":1.0,"source":"backtest-oos","v":3}
{"criterion":"robustness_jitter","weight":0.1,"source":"verify-suite","v":3}
```

- **Reward = the vector**; the scalar α/β update is a *weighted projection* of the vector (DORB's meta-bandit decides which criterion the *next card* should emphasize — see §7)
- Weights live in config (`goal-vector.jsonl` is versioned state; `bandit goal --weights` shows and `--set-criterion` edits at runtime, with provenance)
- Floors are hard: a floor violation zeroes the scalar *regardless of weights* (the constitution can't be out-voted)
- No single metric may dominate: the loader rejects any weight > 0.5 (runtime check)

## 6. Divergence monitor (requirement 5) — the held-out channel

**Build: `bandit audit` + `heldout/`.** Every N-th completed card (N=20, ≈5% of traffic ≥ the 2% floor) is **re-executed independently** — different serf instance (fresh session, no prior-round feedback), and scored against the TRUE objective clauses directly by an evaluator **independent of the proxy chain**:

- The *proxy* score: the loop's own gate + critic (what the policy optimizes)
- The *true* score: fresh verify-suite run + critic-with-fresh-eyes + (where available) the decisions-port demonstrability probability — deliberately a different signal path than the optimizing rounds used
- **Divergence score** per card = proxy_score − heldout_score (both normalized to the reward vector). Maintained as an EWMA over the held-out stream.
- **Alert** (Karwowski et al.'s Corollary 1 calibrates the threshold): when the EWMA gap exceeds `divergenceThreshold` (default 0.15) over a 3-held-out-card window, emit `divergence.fired { gap, window, criteria }` and trigger §7's retirement flow. Gao et al.'s scaling-law curve informs the default: divergence grows predictably with optimization pressure (KL-from-init), so the monitor also tracks cumulative policy drift (posterior distance from the setup priors) as a second axis.
- The held-out channel is **read-only for the policy**: no α/β updates flow from held-out runs (their results never feed back — the SoL-Pi isolation discipline, already a bandit invariant).

## 7. Adaptive criteria (requirement 6) — retire, promote, log; generator independent

**Build: `criteria.jsonl` + the retirement flow.** Triggered ONLY by divergence firing or plateau (a criterion's score flat over its last 5 held-out checks — never a schedule):

a. **Retire/down-weight**: the fired criterion gets `weight *= 0.5` and status `suspect` (with the divergence evidence inline). Twice fired → `retired` (weight 0).
b. **Promote the next frontier**: the criterion generator is the **critic + refiner, independent of the policy** — the critic proposes replacement criteria from the divergence evidence (its verdicts cite *what the actor gamed*; CARMO's per-instance generation, adapted to factory level: per-divergence, not per-instance). Generated criteria enter `criteria.jsonl` at weight 0.1 (probe status) and must earn weight through held-out agreement before promotion.
c. **Log the transition**: `criterion.retired { criterion, evidence, from_weight, to_weight, reasoning }` + `criterion.promoted { criterion, probe_weight, source }`. Reversible (rollback via snapshots, as everything).

The independence guarantee is structural: the *policy* is the actor + governor (it optimizes criteria); the *generator* is critic + refiner (it never receives α/β updates). DORB's Exp3-over-criteria sits here as the meta-bandit: which criterion the next convergence round emphasizes is sampled from per-criterion "expected gain" — but criterion *existence* is the critic's job, not the meta-bandit's.

## 8. Exploration floor (requirement 7)

**Build:** `p_min = 0.05` — enforced at selection time: when sampling the next lever to pull (or serf to route), any arm with posterior share < 5% gets a **forced pull slot every 20 pulls** (deterministic schedule, logged `exploration.floor { arm, pullNo }`). Thompson sampling stays the selector; the floor is a constraint on the selector, not a second policy. Wrong-pull cost analysis (§1) says 5% is affordable — a wasted card is cheap; a collapsed policy is not detectable any other way.

## 9. Reward capping (requirement 8)

**Build:** every scalar reward entering α/β updates is clamped to `[0, R_MAX]` with `R_MAX = 1.0` per single observation (a payoff can't add more than one unit of corroboration mass — the ledger's `magnitude` already caps at 0.6–1.0; make it explicit in `updateOnPayoff`). Justification: Kwa et al.'s heavy-tail result — a single spectacular reward (one lucky card) must not buy permanent dominance; capping bounds the tail. The *aggregate* is bounded by the floor + divergence monitor, not by capping.

---

## 10. The gaming simulation (EST-style deliverable)

`tests/gaming-simulation.test.ts`:
1. Build a synthetic ledger: 3 levers, one with a *corrupted evaluator* (its proxy score inflates: reward += 0.3 while held-out stays flat)
2. Run 60 synthetic pulls through the governor with the divergence monitor
3. Assert: (a) the inflated lever's α rises first (the trap works), (b) divergence fires within 3 held-out windows, (c) the criterion is down-weighted and a replacement probes the frontier, (d) no lever's share collapsed below the floor, (e) the full transition is in the event log with reasoning

Plus the EST perturbation harness: the stress test applies format/context perturbations to critic prompts (the evaluator) and asserts score invariance — an evaluator whose verdict flips on formatting is *already gamed*; that check runs in `bandit audit --stress`.

## 11. Runbook: what to do when divergence fires

| Situation | Action |
|---|---|
| Divergence fired once, gap small (0.15–0.3) | Down-weight criterion ×0.5, increase held-out rate N=20→10, keep trading. No freeze. |
| Divergence fired twice on same criterion | Retire it; promote replacement; **freeze the top arm's weight growth** (its α stops growing until the replacement has ≥3 held-out agreements) |
| Gap large (>0.5) or widening across criteria | **Full stop on optimization** (`bandit goal --freeze`): policy keeps *operating* (paper/life-safety modes unchanged) but no α/β updates until a human reviews the divergence evidence. Escalation surface: the event log + `bandit audit` output, designed to be readable without the factory. |
| Divergence *impossible* to evaluate (held-out channel itself degraded) | Alarm differently: `audit.stale` — if held-out hasn't produced a score in 5×N cards, the monitor is blind; treat as divergence-equivalent. A factory that can't be audited is not running. |

## 12. Success criteria, mapped

- ≥N days without intervention: the loop already holds + heartbeats; add the audit cadence (held-out every 20 cards) as part of normal flow
- Environment shift detection: γ-decay reweights posteriors within ~W effective observations; assert in sim that a mid-run distribution change flips the top arm within M=20 pulls
- Gaming detection: the EST simulation asserts divergence fires within K=3 held-out windows
- No full collapse: the floor guarantees it structurally

## 13. What we deliberately do NOT build

- **Redis/Kafka/stream processing** — card folders + JSONL already are the durable state and the queue; the volume doesn't justify it (Udemy's stack is for 1000× our throughput)
- **KL-divergence regularization of the policy** — Kwa et al. prove it doesn't survive heavy tails; capping + divergence monitoring + floor is the stack that does
- **A separate "true objective scorer" service** — the held-out channel uses bandit's own existing organs (verify suite, fresh critic, decisions port) run *independently*; adding a dedicated scorer duplicates them

## 14. References

- [Karwowski et al. 2023 — Goodhart's Law in RL](https://arxiv.org/abs/2310.09144) — divergence threshold calibration (Corollary 1)
- [Gao et al. 2023 — Scaling Laws for Reward Overoptimization](https://arxiv.org/abs/2210.10760) — KL-from-init as second monitor axis
- [Kwa et al. 2024 — Catastrophic Goodhart](https://arxiv.org/abs/2407.14503) — reward capping justification
- [CARMO (ACL 2025)](https://aclanthology.org/2025.findings-acl.114/) — dynamic criteria generation template
- [DORB (EMNLP 2020)](https://aclanthology.org/2020.emnlp-main.625/) — meta-bandit over criteria
- [EST (2025)](https://arxiv.org/abs/2507.05619) — evaluator stress test template
- [Udemy engineering](https://medium.com/udemy-engineering/building-a-multi-armed-bandit-system-from-the-ground-up-a-recommendations-and-ranking-case-study-8f09f65d26b6) — read for the feedback-pipeline *shape*; deliberately not adopted at bandit's volume
- Bandit's own: [architecture.md](../architecture.md) · [appropriations.md](../appropriations.md) — entries added if built