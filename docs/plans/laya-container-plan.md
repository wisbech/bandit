# Plan — Self-contained factory containers + Laya as the local decision model

Status: DRAFT (master/critic review before build)
Date: 2026-09-24 | Sources: [Laya](https://brainfunctioncollapse.com/laya#run-it) · [laya code](https://github.com/NandhaKishorM/laya) · [weights](https://huggingface.co/convaiinnovations/laya) · [paper](https://arxiv.org/abs/2503.23303) · follows [beacon-routing-plan.md](beacon-routing-plan.md) §6

## 0. TL;DR

Two ideas arrived in one question — separate them:

1. **Laya** (the site's actual subject): an open-weights 322M decision model — typed questions in, probabilities out, 21 ms, zero tokens, Apache-2.0, runs offline. It is a **local Jev replacement**. This is a *strong yes* for bandit: it converts the beacon-routing plan's biggest liability (a hosted evaluator, fail-closed to a vendor) into a local, free, calibrated primitive. Adopt as the routing evaluator **and** as the reducer/critic-gate question-answerer.
2. **Factory-in-a-container** (spin up a harness that works by itself in a container): bandit *already* has the parts — `containerStage()` wraps verification in `docker exec`, the folder IS the state, one command boots a loop. What's missing is a first-class `factory run` packaging: one image, volume-mounted `.bandit/`, the loop as PID 1, no host agent CLIs needed inside. This is *worth doing* but is an **operational** decision (isolation, reproducibility, fleet), not an intelligence one — and the Jev routing-trap math applies: a container factory that needs parent context pays transport. Self-containment is the whole point; design for it deliberately.

Recommendation: **P0 = Laya integration (behind the existing `reducer`/`routing` config shape), P1 = factory container image.** Both are small; neither blocks the other.

---

## 1. Laya: what it is, what it changes

### 1.1 The facts (from the site + repos)

- 322M params, 650 MB disk, ~2.3 GB download, ~90 s cold load; Apple silicon / NVIDIA / CPU
- Typed question API: `choice` / `score` / `noul` (probability a statement is true) / `confidence` — same primitive shapes as TypeSafe Jev, answered in ~21 ms, **no text generated, ever**
- Apache-2.0: code, weights, server (`server.py`, port 8770), local-first — nothing leaves the machine
- Honest limits, documented on the page: can't do arithmetic in-text (do math in code, hand conclusions in words), wording matters a lot (measure 3 phrasings, pick by separation), multilingual checkpoint uncalibrated, graded scores improve with fine-tuning, probabilities should be temperature-calibrated on your own labels
- Ships an agent-skill integration pattern (`.claude/skills/laya-integration`)

### 1.2 Why this beats the hosted-Jev path in beacon-routing-plan.md

The plan's §6.4 already demoted live Jev dispatch to "a testable claim" pending the route ledger. Laya removes the two remaining objections to running the experiment:

| Objection (hosted Jev) | Laya |
|---|---|
| Vendor dependency; fail-closed means "no routing" when offline | Local binary; fail-closed degrades to a 21 ms local default |
| Per-token cost on every card | $0 — the cost gate in Online-Context-Compact-style decisions becomes free to *always* run |
| Latency ~4 s/call — fine for dispatch, too slow for per-step questions | 21 ms — cheap enough for **per-round** and even **per-verification** questions, not just per-card |
| Data leaves the machine | Nothing leaves |

And it opens a question class the plan didn't have: the Jev notes' Table I decisions — *context visibility, cache reuse, tool selection, permission, sensitivity* — are all typed questions. At 21 ms each, bandit can afford to **ask at every round boundary** instead of only at dispatch.

### 1.3 Bandit integration (small surface, same philosophy)

- `src/laya.ts` — thin client: `askLaya(questions, state) -> {answer, probability, calibration}` against `http://127.0.0.1:8770` (the local server), fail-closed wrapper, 2 s timeout, single retry. Same injected-client seam as `typesafe_gate.py`'s design.
- **Routing** (beacon-plan P2): `assessRoute()` gains a Laya backend — Choice over serf/child candidates, Noul per "does this card match factory X's scope". The routing-oracle control stays: Laya routing must beat the track-record selector on new cards.
- **Round-gate questions** (new, Laya-only — too slow to do with Jev/LLM):
  - `noul` "Does this actor run's verification output actually demonstrate the acceptance criterion?" → low confidence ⇒ critic gets a pointed question instead of the whole output (demonstrability, SAT §5)
  - `noul` "Is this verification command vacuous?" — complements the Oracle/NOP vacuous-gate check with a semantic read
  - `score` "How similar is this round's failure to the previous round's?" → feeds `consecutiveSameFailure` with a graded signal instead of regex-matching "missing: …"
- **Calibration discipline (non-negotiable, from the site's own guidance):** fit temperature on bandit's own labeled outcomes (cards that did/didn't converge), pick thresholds from the ledger data, and route *unsure* cases to the critic — the cascade pattern. Never trust raw probabilities; the site says this itself.
- Config: `"laya": { "endpoint": "http://127.0.0.1:8770", "enabled": true }` — same shape as `reducer`. Fail-closed ⇒ all questions silently skipped, factory runs as today.

### 1.4 What Laya is NOT

- Not a reason to touch the confidence ledger — posteriors over *outcomes* stay Thompson-sampled; Laya only adds *predictive* signals at decision time.
- Not a critic replacement. It answers typed questions; it cannot read a 9 KB report adversarially. The cascade pattern is the model: Laya filters/triages, the LLM judges.
- Not trustworthy out of the box on graded scores (their own benchmark says so). Choice/noul first; scores after fine-tuning on bandit's own labeled cards.

---

## 2. Factory-in-a-container: the operational question

### 2.1 What bandit already has

- **Isolation primitive exists**: `containerStage()` wraps verification in `docker exec` when `config.container` is set — the *gate* is already container-aware.
- **State is fully external**: `.bandit/` is folders + JSONL. A container needs exactly one volume mount; the factory state survives container death by design.
- **Boot is one command**: `bandit .` — init if needed, pick harness, watch the board.
- **Budgets/locks are durable**: restart-safe by construction (event-sourced).

So "spin up and work by itself" is mostly **packaging**, not architecture:

### 2.2 What we'd build (`bandit factory image`)

| Piece | Content |
|---|---|
| `Containerfile` | bun + bandit (bundled), git, uv/python (per-project venv discipline), and the chosen agent harness CLI; entrypoint `bandit . --yes --visible none` |
| `factory run` | new CLI verb: `bandit factory up <project>` → builds/starts the container with `.bandit/` volume-mounted, wires herdr visibility from outside (panes live on the host; the loop runs headless in the container), streams events to the host event log |
| Resource policy | `--memory`, `--cpus`, network mode (default: bridge with egress allowlist matching the environment discipline), workspace path allowlist |
| Snapshot/restart | container restart policy + the existing stale-lock auto-clear; crash of the container = crash of one loop, board repairs on replay |
| Multi-factory | one container per factory node; the tree becomes a compose file — parent volumes read-only except their own board |

### 2.3 Why do it (and why not)

**For:**
- **Reproducibility**: the factory's toolchain (bun, uv, venvs, model CLIs) is pinned in the image, not whatever the host has this week — directly addresses the dependency drift we hit (bun upgrade, opencode TUI changes) this month.
- **Blast radius**: a serf that "never installs globally" *can't* in a container. The environment-discipline rule (protocol.md #11) becomes enforced, not instructed.
- **Fleet**: the recursion story (factory tree, departments) needs identical spawnable nodes. Compose-of-factories is the natural scaling unit.
- **Parallelism without panics**: this month's herdr pane crashes were partly many-TUIs-on-one-machine; headless container factories don't care.

**Against / cautions:**
- **The routing trap applies to *operators* too**: a container factory cut off from project context (CLAUDE.md, wiki, references) converges worse, not cheaper. The image must mount the *project*, not just `.bandit/`.
- **Model access** must be solved per-factory (ollama gateway via host network, or keys mounted read-only) — the ACP gateway profile already handles this shape.
- macOS Docker = VM overhead; on this machine the gain is isolation, not speed.
- Don't containerize *panes*: visibility stays herdr-on-host; the container factory is headless and watched via `bandit watch` + event log. The escalation ladder (master+critic panes) is for interactive work on the host.

### 2.3 Sequencing (containers)

| Phase | Deliverable | Gate |
|---|---|---|
| C0 | `Containerfile` + `bandit factory build` — image runs `bandit . --once` against a mounted test project | container card converges identically to host run on the hello-world suite |
| C1 | `bandit factory up/down` (volume mounts, restart policy, event log on host) | factory survives container restart; `board.repaired`-style reconciliation proves state externalization |
| C2 | `verificationContainer` wired to the *same* container (gate runs where the work ran) | self-verify gate exits match host runs |
| C3 | Compose file for a factory tree (parent + 2 children, route records flowing up) | parent routes by ledger, never reads child traffic |

---

## 3. What this does NOT change

- **The critic stays an LLM.** Laya grades/routs/vetoes; it cannot adversarially review a report. SAT's demonstrability result is the reminder: recognition of correct reasoning is the expensive part and it's what the harness is *for*.
- **The confidence ledger stays the governor.** Laya provides predictive signals; posteriors over outcomes remain the track record. Any Laya signal must beat the ledger selector to earn permanence — same test as Jev.
- **Panes stay on the host.** Containers are for the headless fleet; herdr panes remain the human interface.

## 4. Open questions for master/critic

1. Laya first or container first? *(Lean: Laya — it's a config profile + thin client, and it de-risks the routing plan; containers are a bigger operational commitment.)*
2. Should Laya thresholds be per-factory (calibrated on that factory's own convergence history) or global? *(Lean: per-factory once ≥20 cards of history; global defaults before.)*
3. Does the container factory get its own `factory.md` identity and join the route ledger as a first-class route target? *(Lean: yes — that's what makes the tree real.)*

## 5. References

- [Laya — brain function collapse](https://brainfunctioncollapse.com/laya#run-it) (playground, benchmark, integration skill) · [code](https://github.com/NandhaKishorM/laya) · [weights](https://huggingface.co/convaiinnovations/laya) · [paper 2503.23303](https://arxiv.org/abs/2503.23303) · [follow-up 2510.01237](https://arxiv.org/abs/2510.01237)
- [beacon-routing-plan.md](beacon-routing-plan.md) — the plan this extends; §6 routing-trap pricing applies to containers too
- [skill2env](https://github.com/NVlabs/Skill2Env) — Oracle/NOP; the vacuous-gate check pairs with Laya's semantic vacuity question
- [SAT](https://arxiv.org/html/2609.22682v1) — routing-oracle baseline; demonstrability
- [docs/appropriations.md](appropriations.md) — entry added if built