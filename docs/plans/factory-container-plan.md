# Plan — Factory containers: bandit nodes that spin up and run by themselves

Status: DRAFT (master/critic review before build) — **follows the Laya plan**
Date: 2026-09-24 | Sources: bandit's own `containerStage()` + event-sourcing design · [beacon-routing-plan.md](beacon-routing-plan.md) §6 (routing-trap pricing applies to operators too)

## 0. TL;DR

"A harness spun up and working by itself in a container" is **operational packaging, not new architecture** — bandit already has the hard parts: state is fully external (folders + JSONL), the gate is container-aware (`containerStage()`), boot is one command, budgets/locks are restart-safe by construction.

What's missing is the image and the verbs: a `Containerfile` pinning the toolchain, `bandit factory build/up/down`, volume mounts, and a compose file for the factory tree. The wins are **reproducibility** (pinned toolchain — directly addresses this month's bun/opencode drift), **enforced environment discipline** (a serf *can't* install globally), and **fleet** (recursion becomes compose-of-factories). The caution: the routing trap applies to operators too — mount the *project*, not just `.bandit/`, or the factory converges worse, not cheaper.

---

## 1. What bandit already has

| Need | Already exists |
|---|---|
| State externalization | `.bandit/` is folders + append-only JSONL; container death = one loop dead, board repairs on replay |
| Gate isolation | `containerStage()` wraps verification in `docker exec` when `config.container` is set |
| Boot | `bandit .` — init if needed, harness pick, watch the board |
| Crash recovery | Stale-lock auto-clear; event-sourced reconciliation (`repairBoardFromEvents`) |
| Model access shape | ACP gateway profile (e.g. ollama on host network) |
| Visibility | herdr panes on host + `bandit watch` + event log |

## 2. What we'd build

### 2.1 `Containerfile`

```
bun + bandit (bundled cli.js)
git, uv/python (per-project venv discipline)
the chosen agent harness CLI (opencode / pi / claude)
entrypoint: bandit . --yes --visible none
```

### 2.2 New CLI verbs

```bash
bandit factory build                      # build the image
bandit factory up <project>               # start: volume-mount .bandit/ + project, run the loop headless
bandit factory down <project>             # stop
bandit factory ps                         # running factories + their boards
```

- **Mounts**: the project directory (code + context the serfs need) and `.bandit/`; nothing else
- **Visibility**: panes stay on the host — the container loop runs `--visible none`; humans watch via `bandit watch` and the event log. The escalation ladder (master+critic panes) is for interactive host-side work
- **Resource policy**: `--memory` / `--cpus` flags; network mode default bridge with an egress posture matching the environment discipline
- **Model access**: ollama gateway via host network, or read-only mounted credentials — the ACP gateway profile handles this shape already

### 2.3 Why do it

1. **Reproducibility** — the factory's toolchain is pinned in the image, not whatever the host has this week (this month: bun upgrade, opencode TUI regressions, herdr protocol bump)
2. **Blast radius** — a serf that "never installs globally" *can't* in a container. protocol.md rule #11 becomes enforced, not instructed
3. **Fleet** — the recursion story needs identical spawnable nodes; one container per factory node, the tree becomes a compose file
4. **Parallelism without pane panics** — this month's herdr crashes were many-TUIs-on-one-host; headless container factories don't care

### 2.4 Cautions

1. **The routing trap applies to operators**: a container factory cut off from project context (CLAUDE.md, wiki, references) converges worse, not cheaper. Mount the *project* deliberately; context is not optional overhead
2. **macOS Docker = VM overhead** — on this machine the gain is isolation and reproducibility, not speed
3. **Model access must be solved per-factory** before C1; no silent credential baking into images
4. **Don't containerize panes** — herdr stays the human interface on the host

---

## 3. Sequencing

| Phase | Deliverable | Gate |
|---|---|---|
| C0 | `Containerfile` + `bandit factory build` — image runs `bandit . --once` against a mounted test project | container card converges identically to host run on the hello-world suite |
| C1 | `bandit factory up/down` — volume mounts, restart policy, events land in the host event log | factory survives container restart; reconciliation proves state externalization |
| C2 | `verificationContainer` wired to the *same* container — gate runs where the work ran | self-verify gate exit codes match host runs |
| C3 | Compose file for a factory tree (parent + 2 children; child volumes isolated; route records flow up) | parent routes by ledger, never reads child card traffic — protocol.md's tree discipline, enforced by mount design |

---

## 4. What this does NOT change

- **The critic, ledger, and panes stay as they are** — containers package the loop; they don't change the loop
- **Laya first** (see [laya-decision-model-plan.md](laya-decision-model-plan.md)) — it's a config profile + thin client; containers are the bigger operational commitment
- **The routing trap discipline** — every factory-in-a-container decision is priced per-context-rebuild: what context must the container factory load to work well? If the answer is "all of the parent's context," don't containerize that work yet

## 5. Open questions for master/critic

1. Which factory goes first — a fresh small one, or TradingFrontDesk (state-rich, riskier)? *(Lean: fresh — the 7N factory is small and the desk already has docker in its workflow.)*
2. Do container factories get their own `factory.md` identity and join the route ledger as first-class route targets? *(Lean: yes — that's what makes the tree real.)*
3. Egress posture: allowlist-by-default (strict, more setup) or open-until-flagged? *(Lean: allowlist — it's the environment discipline made literal.)*

## 6. References

- bandit's own design: [architecture.md](../architecture.md) (event sourcing, stale-lock recovery, container stage in [src/runner.ts](../../src/runner.ts))
- [beacon-routing-plan.md](beacon-routing-plan.md) §6 — routing-trap pricing (context rebuild dominates); the Jev engineering notes
- [laya-decision-model-plan.md](laya-decision-model-plan.md) — companion plan; Laya questions run identically inside or outside containers
- [docs/appropriations.md](../appropriations.md) — entry added if built