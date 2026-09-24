# Plan — ICM workspaces: organizing the project folder, not just `.bandit/`

Status: DRAFT (master/critic review) · Date: 2026-09-24
Sources: [Interpretable Context Methodology (arXiv 2603.16021)](https://arxiv.org/html/2603.16021v2) · [ICM repo](https://github.com/RinDig/Interpretable-Context-Methodology-ICM-) · companion to [beacon-routing-plan.md](beacon-routing-plan.md), [factory-container-plan.md](factory-container-plan.md)

## 0. TL;DR

The ICM paper (Van Clief & McDermott, Eduba) formalizes the same philosophy bandit was built on — *folder structure as agent architecture, plain text as the interface, one orchestrating agent reading the right files at the right moment*. Nothing has "gone awry" — this is **independent confirmation from outside**, with one genuinely new idea worth appropriating: the **five-layer context hierarchy** and the **Layer 3 / Layer 4 distinction** (the factory vs. the product).

The user's question — *can we organize the folder as well, or is it only bandit we address?* — has a clean answer: **organize the project as an ICM workspace; `.bandit/` is the engine that drives it.** They are complementary layers, not competing ones. Concretely: stages become numbered folders with CONTEXT.md contracts; bandit cards reference stage folders; the loop's plan-phase reads the stage's Inputs table instead of inferring context from scratch.

## 1. The relationship, honestly assessed

| ICM concept | Bandit counterpart | Verdict |
|---|---|---|
| Numbered stage folders = pipeline order | Board columns + card folders | Complementary: ICM organizes *work-in-the-project*; bandit organizes *the machine that does the work* |
| `CONTEXT.md` stage contracts (Inputs/Process/Outputs) | Card `## Task`/`## Acceptance` + serf `prompt.md` | ICM's **Inputs table is sharper** — it names exact files and sections to load per stage. Appropriate. |
| Layer 0–2 (identity → routing → stage contract), ~1.3–1.6k tokens | `plan.md`, serf `prompt.md`, `serf.md` | Already have the layers; ICM's token budgeting is explicit. Adopt the budget targets. |
| **Layer 3 (reference: voice, conventions, design systems — the factory)** | `.bandit/serfs/*/memory/`, project `references/` | The distinction "internalize as constraints" vs "process as input" is the paper's best idea. Bandit serf prompts currently mix both. Appropriate. |
| Layer 4 (working artifacts — per-run) | `card/outputs/`, stage `output/` | Same thing, two namespaces. Map them. |
| Human edit surface at every stage boundary | Card outputs + critic verdicts | Identical philosophy; ICM adds the *U-shape* insight (heavy edits at first and last stage) |
| Single orchestrating agent + sub-agent delegation | Loop + serfs | ICM is *sequential, one agent*; bandit is *parallel, many*. Different regimes — ICM §5.2 says so itself |
| Sequential-only, human-review-gated | Bandit runs unattended, verification-gated | Bandit's differentiator — keep |

**Where something HAS gone awry** — and it isn't the folder philosophy: our two live factories show a split-brain problem. See §4. The paper is a mirror, not a warning.

## 2. The appropriation: `bandit workspace` (ICM layer for projects)

### 2.1 Stage-aware cards

A card can name its stage: `stages: 02_script` in frontmatter. When the loop runs it, the actor's prompt is composed from the stage contract — the card's Inputs table says *which files* to load (Layer 3 reference vs Layer 4 working), and the actor loads exactly those, nothing else. This is **layered context loading enforced by the runner**, replacing "read the plan.md and figure it out."

- Serf prompt stays generic; the *stage contract* carries the specificity
- `runSerfOnCard` gains an inputs-resolution step: parse the card's Inputs table, verify files exist, inline the Layer 3 material as constraints and Layer 4 as input (ICM's own framing)
- Token effect per ICM's Figure 3: 2–8k focused tokens per stage vs 30–50k monolithic — the same math as our ObservationPack, applied at card level

### 2.2 `bandit workspace init` (workspace-builder appropriation)

ICM's workspace-builder (a workspace whose output is a new workspace) maps directly:

```bash
bandit workspace init <project>   # scaffold stages/01_…, 02_…, references/, CONTEXT.md per stage
bandit workspace add-stage        # add a numbered stage with contract template
```

- `plan.md` (bandit) and `CONTEXT.md` hierarchy (ICM) stay separate files with different jobs: plan.md is the *mission*, stage CONTEXT.md is the *contract*
- The five-stage desk plan (`typesafe-integration-plan.md`) becomes the first real workspace: 00_data → 01_gate → 02_backtest → 03_review → 04_deploy

### 2.3 What we do NOT appropriate

- **Single-agent sequentialism** — ICM is human-in-the-loop by design; bandit is verification-gated autonomous. We keep the critic, the gate, and the ledger. ICM's review gates become bandit's *plan critique* (already built).
- **"Human decides between stages"** — replaced by verification + critic with human *escalation* (review column), not human *blocking*.
- The workspace-builder as a product — bandit's version is `bandit workspace init`, ten lines of scaffolding, not a five-stage meta-workspace.

## 3. Sequencing

| Phase | Deliverable | Gate |
|---|---|---|
| W0 | Stage-contract spec + Inputs-table parser (read-only) | no behavior change; serf prompts unchanged |
| 1 | `runSerfOnCard` inputs-resolution: actor loads exactly the Inputs table's files | one pilot card per factory; actor output cites the loaded files |
| 2 | `bandit workspace init` scaffold + TFD desk migrated to stage folders | desk cards reference stages; ledger history preserved |
| 3 | Layer-3/4 separation in serf memory (memory = Layer 3; card outputs = Layer 4) | refiner reads the split; memory writes cite layer |

## 4. Status check — is the bandit goal still working? (asked directly)

Audit of both live factories, 2026-09-24:

**TradingFrontDesk (`.bandit/goal/`)** — **the goal system works and has real history.** `goal.md` carries the fixed objective (maximize E[growth] s.t. P(ruin)≈0, Sharpe ≥ 1.0, drawdown ≤ 20%); the ledger shows `lever:008-typesafe-regime-gate` with a genuine arc: 3 flat pulls (evidence-cited: "actor output is empty", "I independently verified all artifacts on disk") → **retired → re-corroborated → `tested`, lastPaidOff 2026-09-18**. That is the bucket-brigade ledger doing exactly what protocol.md §7 says. The governor (`bandit bandit`) has not activated — needs ≥1 corroborated measure + ≥2 levers with ≥3 pulls; only one lever has history. *Working, not yet converged.*

**BUT the TFD loop is dead**: both `bandit .` processes (39656/42261) died in the Sep 18 herdr/bun crash chaos. Cards 008a/008b are stranded mid-plan in `in-progress/`, and `run.lock` holds a dead pid. **Fix on next start: the stale-lock auto-clear handles the lock; the stranded cards resume via the in-progress frontier scan.** Nothing lost — but it hasn't been restarted.

**7N (Downloads/7N)** — this is where something *has* gone awry, and it's process, not code:

- 9 cards sit in `done/` — but **zero events, zero critic verdicts, empty `goal/`, no goal.md**
- The work was done **manually through the pane agents** (master/critic panes typing `mv`-equivalents), not through the loop — the loop only emits events when *it* processes cards
- Two `bandit .` loops are running there right now (pids 3644, 67371), holding open, watching an empty board; `run.lock` is stale
- Consequence: the 7N factory has **no track record** — the ledger can't learn from work that bypassed the loop, and `bandit events` shows nothing. The factory folder exists but the *factory* never ran.

**Remediation (small, do on next session in 7N):**
1. Kill the duplicate loop; keep one (or both down if the work is finished)
2. Backfill: write `goal.md` for 7N (what was the 9-card mission actually optimizing?)
3. Reconstruct events for the manual work — even one retroactive `card.completed` entry per card restores the audit trail; the ledger reads events, so it can't learn until they exist
4. Rule going forward: **pane agents don't move cards by hand** — they file a card outcome to the board and let the loop (or a `bandit task`-style CLI entry) record the event. Otherwise the factory has two nervous systems and the ledger only sees one.

## 5. References

- [ICM paper](https://arxiv.org/html/2603.16021v2) · [repo](https://github.com/RinDig/Interpretable-Context-Methodology-ICM-) — five-layer context hierarchy, Layer 3/4, stage contracts
- [docs/architecture.md](../architecture.md) — bandit's folder philosophy (invariant #6: "if a feature can't be explained as a file a serf reads or writes, it doesn't go in")
- [docs/appropriations.md](../appropriations.md) — entry added if built
- Local prior art: `desk/plans/typesafe-integration-plan.md` as the first stage-structured card set