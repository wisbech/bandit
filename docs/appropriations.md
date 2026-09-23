# Appropriations — standing on stolen, I mean cited, work

bandit's design didn't emerge from a vacuum. This page credits the research and open-source work we've appropriated — with direct links, because the difference between stealing and scholarship is a citation.

---

## SoL-Pi (NVIDIA / NTU / MIT, 2026) — *the big one*

**[SoL-Pi: Recursively Scaling Auto-Research Loops for Efficient Agent Harness](https://arxiv.org/html/2609.20519v1)** · [code](https://github.com/NVlabs/SoL-Pi) · [blog](https://nvlabs.github.io/SoL-Pi/)

Their claim: an AI optimizer iteratively improves the agent harness for token efficiency, with capability metrics *strictly isolated from the optimizing agent's control to prevent gaming*. Four mechanisms survived their ~150-direction, ~500-environment search. We read it and said: this is bandit's refiner with better discipline — and four mechanisms we can appropriate directly.

| SoL-Pi mechanism | Paper | Bandit implementation |
|---|---|---|
| **Self-verification gate** — capability metrics isolated from the agent; no gaming | §2.1, [code](https://github.com/NVlabs/SoL-Pi) | `selfVerifyGateAsync` in [src/runner.ts](../src/runner.ts): the harness **re-runs the reported `VERIFICATION_COMMAND`** and uses the actual exit code. The actor's claim is a claim; the gate is a fact. Emits `gate.selfverify` on mismatch. |
| **Evidence-Preserving Reducer** — cheap model compresses big logs into receipts; deterministic verifier checks schema, source hash, exit status, exact quotes; fallback to original on any failure | §2.4 | `reduceEvidence` + `verifyReceipt` in [src/runner.ts](../src/runner.ts): optional `reducer` (e.g. an ollama model) compresses ≥4 KiB gate output; receipt quotes are string-matched against the source; credential-suspect content never reduces; `gate.reduced` / `gate.reduce_failed` events. |
| **ObservationPack** — large observations become a stable handle + 1KB excerpt; exact content retrievable on demand | §2.4 | `packObservation` in [src/runner.ts](../src/runner.ts): actor outputs >10 KiB archive to `card/observations/` and the critic receives the path + head/tail excerpt + a `sed -n 'X,Yp'` recipe, instead of a blind 3000-char slice. |
| **Online Context Compact** — compact at subtask boundaries only when projected savings exceed rewrite cost | §2.4 | Convergence-round digests in [src/loop.ts](../src/loop.ts): rounds ≥2 receive a bounded (last-4) digest of prior rounds — verdicts, gate history, reasoning — instead of re-deriving context. Compaction happens exactly at round boundaries. |
| **Oracle analysis** — examine trajectories to identify *avoidable work* before proposing changes | §2.2 | `oracle_waste` signature class in [src/refiner.ts](../src/refiner.ts): self-verify mismatches and failed receipts are now refiner triggers alongside failure signatures. |
| **Held-out isolation** — frozen candidates never see validation results | §2.2 | Already native: refiner snapshots + `--rollback`, evidence-cited edits, and the confidence ledger's separation of claims from corroboration. The paper independently validates this discipline. |
| **Verifier-driven environments** — executable success criteria, multiple valid paths | §2.3 | Bandit cards *are* verifier-driven environments — the acceptance criteria + verification command. The appropriation runs the other way: the paper's gate rigor is what our cards now enforce against the actor. |

Their headline result: 44.7–49.0% token-traffic reduction and ~⅓ cost at comparable capability. Our claim is narrower: the same mechanisms, applied to bandit's serf↔serf traffic, close the fabrication hole (self-verify) and cut critic-input tokens (pack + reduce + digest). Measured in bandit's own currency: `gate.selfverify`, `gate.reduced` events and `lifetimeTokensUsed` deltas per card.

---

## Earlier appropriations

### Thompson sampling — the bandit governor
**[Thompson (1933), "On the Likelihood that One Unknown Probability Exceeds Another"](https://www.jstor.org/stable/2332286)** · Beta-Bernoulli bandits, as taught by every [multi-armed bandit survey](https://arxiv.org/abs/1904.07272) since.

`bandit bandit` in [src/bandit.ts](../src/bandit.ts) — each lever carries a Beta(α,β) posterior; pulls sample α/(α+β); exploration vanishes as posteriors separate. The name of the whole project is this appropriation.

### Event sourcing
**[Fowler's event-sourcing pattern](https://martinfowler.com/eaaDev/EventSourcing.html)** · [Kafka's log abstraction](https://kafka.apache.org/documentation/#log)

`.bandit/events/*.jsonl` in [src/loop.ts](../src/loop.ts) — append-only JSONL is the truth; the board is a projection; `repairBoardFromEvents` replays and repairs. State is derivable, truth is the log.

### The Ralph Loop (Geoffrey Huntley) — implement → review → revise
**[ralph.wiggum](https://ghuntley.com/ralph/)** — "a technique for getting agents to do more than one turn of work": run the loop until the completion criterion holds.

SoL-Pi extended their auto-research cycle with exactly this. bandit's convergence rounds ([src/loop.ts](../src/loop.ts)) are the same shape: bounded rounds of attempt → gate → critique → revise, with escalation instead of infinity.

### Kanban — the board
**[Anderson, "Kanban"](https://lean.org)** · [the canonical card columns](https://en.wikipedia.org/wiki/Kanban_board)

`.bandit/board/{backlog,in-progress,review,done}` — a card is a folder, WIP limits are budgets, review is the critic's escalation path.

### Event modeling / folder-as-state — serf (v2) heritage
**[serf](https://github.com/wisbech/serf)** — the v2 predecessor: dark factory, master serf + GAN critic, folder-per-agent. bandit is v3 of this lineage; `bandit migrate` folds v2 state forward.

### Harness-remote — the control-plane shape
**[giuliastro/harness-remote](https://github.com/giuliastro/harness-remote)** — native-session control plane for Codex, Claude Code, OpenCode, OMP and PI. Their Machine→Project→Session model and agent-scoped routes are the shape bandit's `acp` transport speaks; their docs are the reference for the harness-capability discipline ("never invent a control the harness didn't advertise" — [their capability matrix](https://github.com/giuliastro/harness-remote/blob/main/docs/V3_HARNESS_CAPABILITY_MATRIX.md) formalized what our protocol.md asserted).

### Agent Client Protocol (Zed / ACP)
**[agentclientprotocol.com](https://agentclientprotocol.com)** · [spec + schema](https://github.com/agentclientprotocol/agent-client-protocol) · [claude-agent-acp adapter](https://github.com/agentclientprotocol/claude-agent-acp) · [codex-acp](https://github.com/zed-industries/codex-acp)

The universal spoke: one JSON-RPC-over-stdio lifecycle (initialize → session/new → prompt → session/update) drives Claude Code, Codex, OMP and pi. Our `acp` transport in [src/runner.ts](../src/runner.ts) is a minimal client of their protocol; the gateway-auth pattern (client-managed LLM routing) is theirs, and it's how bandit drives Claude Code's own adapter from a local ollama model.

### SWE-agent — the agent–computer interface thesis
**[SWE-agent](https://arxiv.org/abs/2405.15793)** · [code](https://github.com/SWE-agent/SWE-agent)

"Changing the agent–computer interface around a fixed model can materially affect performance" — the paper that legitimized the harness as a first-class engineering surface. bandit's harnesses-as-adapters design (protocol.md rule 4) stands on this.

### Gödel Machine → Darwin Gödel Machine — self-reference with receipts
**[Schmidhuber's Gödel Machine](https://arxiv.org/abs/cs/0309048)** · **[Sakana's Darwin Gödel Machine](https://arxiv.org/abs/2505.22954)** · [code](https://github.com/jennyzzt/dgm)

Self-modification backed by an empirical archive: keep what demonstrably improves, roll back what doesn't. bandit's refiner (snapshots, evidence-cited edits, rollback, evidence-gated everything) is this discipline applied to factory prompts and memory rather than agent code.

### GEPA — reflective prompt evolution
**[GEPA (Agrawal et al., 2025)](https://arxiv.org/abs/2507.19457)** · [code](https://github.com/gepa-ai/gepa)

Reflection on execution trajectories to improve prompts. Bandit's refiner proposes prompt/memory edits from failure signatures — GEPA's move, embedded in a factory loop.

### Meta-Harness / AHE — transfer as the acceptance bar
**[Meta-Harness](https://arxiv.org/abs/2509.26024)** · **[AHE](https://arxiv.org/abs/2510.08114)**

Both evolve harness components and evaluate on *held-out* tasks and models — and both found (as Wang et al. documented) that evolved harnesses overfit their search tasks. SoL-Pi's frozen-candidate discipline and bandit's snapshot/rollback are both answers to the same finding: **a change that only helps the task you saw is not a change.**

### Pi / Oh-My-Pi — the efficiency baseline
**[pi](https://github.com/badlogic/pi-mono)** (Mario Zechner's minimal coding agent) — the base harness SoL-Pi optimized; its "the harness is a few hundred lines you can actually read" philosophy is bandit's `src/` design brief. The `pi` integration verified in this repo (provider/model normalization, TUI + headless shapes) came from reading their code.

### OpenCode — the default worker
**[opencode](https://github.com/sst/opencode)** · [their acp server](https://github.com/sst/opencode/pull/acp)

The default headless and pane harness in bandit, and the transport we've hammered the hardest (TUI boot races, model routing, `run` argv semantics). Their `opencode acp` server also gives bandit an ACP-native worker for free.

### herdr — the panes
**[herdr](https://herdr.dev)** — terminal-native agent multiplexer. The pane transport, `pane.send_text`/`send_keys` injection pattern, and the whole "serfs are visible and steerable" interface live on the herdr socket ([src/herdr.ts](../src/herdr.ts)). Their server is the substrate; bandit is a client.

### Ollama — the local backend
**[ollama](https://github.com/ollama/ollama)** — every model in its catalog works with every bandit harness, and its Anthropic-compatible endpoint is the verified gateway behind the ACP self-hosting path. Local-first factories run on this.

### Beacon — typed routing questions (planned)
**[Asymptote-Labs/agent-beacon](https://github.com/Asymptote-Labs/agent-beacon)** · [cross-harness memory docs](https://docs.beacon.sh/concepts/cross-harness-memory.md) · [detection engine](https://docs.beacon.sh/detections/engine.md)

Beacon's use of TypeSafe Jev — bounded, redacted projections answered with typed probabilities, review-gated, provenance-stored — is the pattern behind the planned routing layer ([draft plan](plans/beacon-routing-plan.md)): evoke the right agent / folder / child factory by typed question, subtract-only, fail-closed. We appropriate the *question discipline*, not the capture layer — bandit's event log already is the trace.

---

## The rule we're stealing toward

> A mechanism earns its place by surviving a gate it cannot see: capability within tolerance, efficiency beyond threshold, validation held out. Everything else is a vibe.

SoL-Pi §2.1 says it in eight words we couldn't say better: *capability metrics stay outside the optimizing agent's control*. Bandit now runs its gate the same way.

If you borrow from bandit, this page is the receipt. [Open a PR](https://github.com/wisbech/bandit/pulls) if we've missed a source — appropriation without attribution is just theft with extra steps.