# Plan — Laya: the local decision model for bandit

Status: DRAFT (master/critic review before build) — **priority over the container plan**
Date: 2026-09-24 | Sources: [Laya](https://brainfunctioncollapse.com/laya#run-it) · [laya code](https://github.com/NandhaKishorM/laya) · [weights](https://huggingface.co/convaiinnovations/laya) · [paper](https://arxiv.org/abs/2503.23303) · [follow-up](https://arxiv.org/abs/2510.01237) · extends [beacon-routing-plan.md](beacon-routing-plan.md) §6

## 0. TL;DR

Laya is an **open-weights local Jev replacement**: a 322M-parameter model that answers typed questions (choice / score / noul / confidence) with probabilities in ~21 ms, generating zero text, on your own machine, Apache-2.0. It dissolves the beacon-routing plan's biggest liability — a hosted evaluator with vendor fail-closed — and unlocks a question class that hosted-Jev latency made impossible: **per-round and per-verification questions, not just per-card dispatch**.

Recommendation: adopt as the routing evaluator's local backend **and** as a new round-gate question answerer. Small surface: one thin client, one config profile, fail-closed by construction.

---

## 1. The facts

| Property | Value |
|---|---|
| Parameters / disk | 322M / 650 MB (2.3 GB download) |
| Latency | ~21 ms per decision (Apple M1 Max measured); cold load ~90 s |
| Output | Typed answers with real probabilities — **no text generated, ever** |
| License | Apache-2.0 (code + weights) |
| Runs | Apple silicon, NVIDIA, plain CPU; local server on 127.0.0.1:8770 |
| Data | Nothing leaves the machine |

**Documented limits (from the site itself — take them seriously):**
- Cannot do arithmetic in-text — do math in code, hand conclusions in words
- Wording matters a lot (`blocked by a barrier` separated classes 0.75; `blocked by a train` only 0.45) — measure 3 phrasings, pick by separation
- Graded `score` answers improve a lot with fine-tuning; `choice`/`noul` are strong out of the box
- Multilingual checkpoint ships uncalibrated
- Probabilities must be temperature-calibrated on your own labels; thresholds picked from data; unsure cases escalate to a person (or here, to the critic)

## 2. Why Laya over hosted Jev

| Objection (hosted Jev) | Laya |
|---|---|
| Vendor dependency; fail-closed = "no routing" when offline | Local binary; fail-closed degrades to a 21 ms local default |
| Per-token cost on every card | $0 — cost gates become free to *always* run |
| ~4 s/call — fine for dispatch, too slow per-step | 21 ms — per-round and per-verification questions are affordable |
| Data leaves the machine | Nothing leaves |

The Jev engineering notes' Table I decision points — context visibility, cache reuse, tool selection, permission, sensitivity — are all typed questions. At 21 ms each, bandit can ask at **every round boundary** instead of only at dispatch.

## 3. Bandit integration

### 3.1 The client

`src/laya.ts` — thin, mirror of the desk's `typesafe_gate.py` design:

```ts
askLaya(questions, state) -> { answer, probability, calibration }
```
- Local server `http://127.0.0.1:8770`; 2 s timeout; single retry; **fail-closed** (skipped questions, factory unchanged)
- Injected client seam for mocking (the critic-approved pattern)
- Bounded, redacted state projections — same discipline as Beacon's trace projection

### 3.2 The questions (bandit's Table I)

| Decision point | Question to Laya | Consumed by |
|---|---|---|
| **Routing** (beacon-plan P2) | `choice` — which serf/child factory handles this card? · `noul` — does this card match factory X's scope? | `assessRoute()` — the routing-oracle control still applies: must beat the track-record selector on new cards |
| **Round gate** | `noul` — does this verification output actually demonstrate the acceptance criterion? | Low confidence ⇒ critic gets a pointed question, not the whole output (demonstrability per SAT §5) |
| **Vacuity** | `noul` — is this verification command vacuous? | Semantic complement to the Skill2Env Oracle/NOP check |
| **Failure similarity** | `score` — how similar is this round's failure to the previous? | Feeds `consecutiveSameFailure` with a graded signal instead of regex-matching "missing: …" |
| **Cascade** | `confidence` — act or escalate? | Confident answers act; unsure cases go to the critic — never the reverse |

### 3.3 Calibration discipline (non-negotiable)

The site's own guidance, adopted as ours:
1. **Fit temperature** on bandit's own labeled outcomes (cards that did/didn't converge)
2. **Pick thresholds from ledger data**, not vibes
3. **Cascade**: act on confident answers; escalate unsure ones to the critic — never act on unsure
4. **Per-factory calibration** once ≥20 cards of history; global defaults before
5. Wording: measure 3 phrasings of each question on historical outputs, keep the one with the best class separation

### 3.4 Wiring

- Config: `"laya": { "endpoint": "http://127.0.0.1:8770", "enabled": true }` — same shape as `reducer`; fail-closed ⇒ all questions silently skipped, factory runs as today
- Loop call sites: after `pipelineFor()` (routing), at each round boundary (round gate, failure similarity), in `runSerfOnCard` (vacuity + cascade)
- `bandit laya` — health + calibration view: recent questions, hit rates, threshold drift, agreement with ledger outcomes (like `bandit bandit` renders the governor)

## 4. What Laya is NOT

- **Not a ledger replacement** — posteriors over outcomes stay Thompson-sampled; Laya adds *predictive* signals at decision time only
- **Not a critic replacement** — it answers typed questions; it cannot adversarially review a 9 KB report. Laya filters/triages; the LLM judges
- **Not trustworthy on graded scores out of the box** — choice/noul first; scores after fine-tuning on bandit's own labeled cards
- **Not mandatory** — every question is skippable; `enabled: false` is byte-identical to today's behavior

## 5. Sequencing

| Phase | Deliverable | Gate |
|---|---|---|
| L0 | `src/laya.ts` client + fail-closed wrapper + mocked tests | tsc clean; no live calls |
| L1 | Round-gate questions live (demonstrability + vacuity + failure similarity), events emitted (`laya.asked`, `laya.escalated`) | 2 weeks of cards: escalation precision vs critic-only baseline |
| L2 | Routing backend for `assessRoute()` | routing-oracle control: beats track-record selector on new cards, or the flag goes off |
| L3 | Per-factory temperature calibration on ledger history | thresholds stable across two consecutive calibrations |

## 6. Open questions for master/critic

1. Per-factory or global thresholds? *(Lean: per-factory after ≥20 cards; global defaults before.)*
2. Should Laya's "does this output demonstrate the criterion?" question run *before* the critic (cheap pre-filter) or only on critic-escalation? *(Lean: before — it makes the critic's job pointed instead of blind.)*
3. Do Laya signals get ledger standing (a new claim kind) or stay advisory forever? *(Lean: advisory until they demonstrably predict convergence; then ledger claims like any measure.)*

## 7. References

- [Laya — brain function collapse](https://brainfunctioncollapse.com/laya#run-it) (playground, benchmark, integration skill)
- [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya) · [weights](https://huggingface.co/convaiinnovations/laya)
- [arXiv 2503.23303](https://arxiv.org/abs/2503.23303) · [arXiv 2510.01237](https://arxiv.org/abs/2510.01237)
- [beacon-routing-plan.md](beacon-routing-plan.md) §6 — the routing-oracle control and routing-trap pricing
- [Jev engineering notes](https://drive.google.com/file/d/17h982xvsL3E7b80iGmOCfKp9qTOW9ohv/view) — Table I decision points
- [SAT](https://arxiv.org/html/2609.22682v1) — demonstrability; the round-gate question is demonstrability operationalized
- Joins [docs/appropriations.md](../appropriations.md) if built