# bandit

<p align="center">
  <a href="https://wisbech.github.io/bandit/"><img src="docs/bandit-icon.png" alt="bandit — the agent factory" width="380"></a>
</p>

<p align="center"><a href="https://wisbech.github.io/bandit/"><strong>wisbech.github.io/bandit</strong></a></p>

**The agent factory.** A dark factory where AI coding agents execute work on a kanban board, an adversarial critic enforces quality, and every claim is backed by verification evidence — not vibes.

```
   ┌──────────────────────────────────────────────────────────┐
   │                       THE LOOP                           │
   │                                                          │
   │   board ─▶ master ══▶ actor ──▶ verify gate (mechanical) │
   │    ▲            ║                        │               │
   │    │      consult thread                 ▼               │
   │    │      ══▶ critic (peer, summonable) ─┤               │
   │    │            ▼                        │               │
   │    └──── grader seat ────────────────────┘               │
   │        verdict: pass/fail/uncertain · gate decides done  │
   └──────────────────────────────────────────────────────────┘
```

> **A serf is a folder. A card is a folder. Events are the truth. Harnesses are adapters.**

bandit coordinates multiple AI coding harnesses (opencode, Claude Code, Codex, pi…) as workers on a shared board, measures whether their work moves the needle, and governs its own confidence about what works. It is the third generation of the serf idea — proven across years of daily production use.

---

## Why

Agent harnesses are powerful but unmanaged. You babysit one session at a time, paste context by hand, and trust output that was never verified. bandit flips that:

- **Cards instead of conversations.** Work is a kanban card with acceptance criteria, not a chat transcript.
- **Verification instead of vibes.** Every actor must report a `VERIFICATION_COMMAND` and its exit code. Green or it didn't happen.
- **A critic with teeth — and a voice.** A classifier seat grades every result against the card; a peer critic argues in a threaded consult at plan time, on stagnation, and at routing — and can summon researchers into the conversation. Plumbing failures retry the *seat*, never the actor.
- **Events are the truth.** Append-only JSONL; the board is a projection. Replay repairs a corrupted board — no state to corrupt that isn't reconstructible.
- **Bounded autonomy.** Convergence rounds (default 3), budget hard-stops, stealable locks, stall detection. A hung agent is killed, not waited on.

## Install

```bash
git clone https://github.com/wisbech/bandit.git
cd bandit
bun install          # bun is the only dependency
ln -sf $(pwd)/bin/bandit.js /opt/homebrew/bin/bandit   # or add ./bin to PATH
```

Requirements: [Bun](https://bun.sh) ≥ 1.4, and at least one supported coding-agent CLI.

## Quick start

```bash
cd your-project
bandit .             # init + start — interactive picker (agent, model, visibility)
```

That opens the factory: it scaffolds `.bandit/`, asks which harness to run, which model, and which serfs you want to *see* live — then watches the board forever.

Add work:

```bash
bandit task "fix the flaky login test" \
  --accept "pytest tests/test_login.py passes 3x in a row"
```

Watch it run:

```bash
bandit watch         # live dashboard: agents, cards in flight, board, events
bandit events        # the event log — the truth
bandit board         # the kanban
```

## The actor–critic loop

Every card runs a bounded convergence dialogue refereed by the confidence ledger:

1. **Consult first (non-trivial cards).** The actor produces a plan; the master shows it to the critic *as a peer* — the critic argues free text and answers `DECISION: proceed | amend | reject`. It may **summon** a domain voice (`SUMMON: researcher`) — a spawned serf whose argument joins the thread. Bad plans die before execution tokens burn; amended plans carry the argument forward.
2. **Actor pulls.** Executes the card, edits real files, reports a verification command.
3. **Gate.** The harness re-runs the reported command itself and uses the *actual* exit code. Red → the seat triages (fixable by skill, or missing prerequisite?). A grader pass at a red gate is recorded as a contradiction — the seat's confidence is self-reported, the gate is not.
4. **Grader seat.** One cheap call, criterion-by-criterion, track record in `.bandit/grading/`. It can never join the room it grades.
5. **Stuck?** One consult: *same wall or different wall?* The specialist spawn falls out of the conversation instead of a regex counter.
6. **Converged?** Green + (pass, or plumbing-bypass, or low-confidence fail) → done. Routed `amend`? The card requeues to backlog automatically (bounded at 2) — the loop re-opens its own review cards.
7. **No convergence after 3 rounds?** The master routes (retry / specialist / escalate) on the full consult thread. Nothing silently disappears.

The consult thread lives in the card folder (`card/consult.md`) — every argument, summon, and decision is part of the deliverable. Summons are one-shot, budget-counted, and registered as child serfs: the compounding of a research conversation, mechanically.

## Harnesses — any agent, one interface

`.bandit/harnesses/*.json` — one declarative profile per harness. The factory owns identity and state; the harness owns its native session.

```json
{
  "name": "acp",
  "command": "npx",
  "args": ["--yes", "@agentclientprotocol/claude-agent-acp"],
  "protocol": "acp",
  "gateway": { "baseUrl": "http://localhost:11434", "headers": { "x-api-key": "ollama" } },
  "model": "glm-5.3-flash:cloud"
}
```

```bash
bandit harnesses                        # list installed profiles (● = active)
bandit harnesses add acp-pi npx --yes @some-pi-acp-adapter --protocol acp
bandit start --transport acp            # switch factories, not workflows
```

Four protocols, one factory:

| Protocol | How it runs | Good for |
|---|---|---|
| `headless` | spawn CLI with prompt on argv, gate on exit | opencode/claude/codex/pi one-shots |
| `acp` | [Agent Client Protocol](https://agentclientprotocol.com) over stdio — Claude Code (via adapter), Codex, OMP, pi | the universal spoke; gateway auth routes to **any** Anthropic-protocol backend — local ollama, hosted gateways, or any provider speaking the Anthropic API shape |
| `herdr` | live TUI in a pane | watching + steering mid-run |
| `uhp` | HTTP `/v1/responses` | hosted endpoints |

The ACP adapter speaks the [harness-remote](https://github.com/giuliastro/harness-remote) shape too — remote control planes are a profile, not a fork.

**Any LLM works with every agent.** Models are normalized to `provider/id` and routed per harness: the interactive picker lists your live ollama catalog, the ACP gateway accepts any Anthropic-protocol endpoint (self-hosted or hosted), and `uhp` reaches any `/v1/responses` host — pi, opencode and claude all take the same model spec. Local or cloud, open-weights or proprietary: swap the model, keep the factory.

## Visibility is a launch choice

```bash
bandit start --visible none            # headless — watch via `bandit watch`
bandit start --visible actor           # just the actor
bandit start --visible actor,critic    # the GAN, live
bandit start --visible all             # every serf in a herdr pane
```

Pick interactively at launch, persist it in `config.json`, or override per run. Only *missing* panes open — rejoining a live factory doesn't duplicate workers.

## Chat with your serfs

```bash
bandit chat critic                  # walk into the critic's pane and talk
bandit chat actor --agent claude    # chat via a different harness
```

Serfs live in the loop while it runs. You type to them mid-run; they answer in their pane. The human joins the factory, not a separate dashboard.

## Confidence, measured

- **Bucket-brigade ledger** during bootstrap: claims corroborated by independent measures gain standing; established = probability, not a feeling.
- **Thompson-sampling governor** when instruments converge: ≥1 corroborated measure + ≥2 levers with real pull history → posteriors replace hunches. `bandit bandit` shows the posteriors.
- **Levers and measures**: a goal is discovered, not decreed. Levers are hypotheses; measures are external-source instruments; pulls update the ledger.

## The refiner — the factory improves itself

After the board drains, failure signatures trigger a refiner pass: it reads the event log, proposes edits to serf prompts/memory/structure **with evidence**, snapshots first, applies, and every pass is reversible (`bandit refine --rollback <ts>`). Two consecutive `critic.repair` events, for example, trigger a transport-plumbing lesson written into the critic's memory — by the factory, about itself.

## Commands

```
bandit init            scaffold .bandit/ in the current project
bandit task            add a card: bandit task "title" --accept "criterion"
bandit board           show the kanban
bandit start           run the factory loop (--agent/--model/--visible/--transport)
bandit watch           live wave view — subscribes to events, renders on append
bandit card <id>       the dossier: timeline, consult thread, verdicts, artifacts
bandit doctor          9-point health check (exit 1 on failure — CI-safe)
bandit serf            spawn a serf by hand (role template, mission, card binding)
bandit events          show the event log (the truth)
bandit chat            walk into a serf's pane and talk
bandit panes           open/close visible serf panes (herdr)
bandit harnesses       list/add harness adapter profiles
bandit confidence      the confidence ledger
bandit bandit          the Thompson-sampling governor
bandit refine          self-improvement pass (--force, --rollback, --history)
bandit migrate         fold a v2 .serf/ into .bandit/
```

## Invariants

1. One factory per project root per node.
2. Events are append-only; every state change is reconstructible.
3. Plumbing failures never punish the worker.
4. Budget is a hard stop; counters survive restarts.
5. Never invent a control the harness didn't advertise.
6. If a feature can't be explained as "a file a serf reads or writes," it doesn't go in.

## Architecture in one screen

```
.bandit/
├── plan.md               # mission + current direction
├── config.json           # agent/model/transport/visibility
├── harnesses/            # adapter profiles (the universal spoke)
├── board/
│   ├── backlog/          # cards waiting
│   ├── in-progress/      # cards being executed (outputs land inside)
│   ├── review/           # escalations (critic verdicts travel with the card)
│   └── done/
├── serfs/
│   ├── actor/            # prompt.md, serf.md, journal/, outputs/, memory/, children/
│   ├── critic/           # consult replies + track record (read-only profile)
│   ├── master/           # routing decisions
│   ├── researcher/       # summonable: cites sources, marks unverified claims
│   ├── architect/        # summonable: proposes shapes, names what it would NOT build
│   └── <hand-spawned>/   # bandit serf <name> — same folders, same registry, first-class crew
├── events/               # append-only JSONL — the truth
└── goal/                 # confidence ledger + bandit posteriors
```

Recursion is structural: a factory spawns child factories the way serfs spawn children — folders with lineage. Delegation flows down; established truth flows up. A project grows into a department grows into a company by mechanism first; the org chart is an emergent property of the tree.

## Documentation

| Doc | What it covers |
|---|---|
| [Architecture](docs/architecture.md) | the loop, folders, cards, events, pipelines, the critic, confidence, budgets, recursion |
| [Harnesses](docs/harnesses.md) | adapter profiles, the four protocols, ACP lifecycle, gateway auth (any LLM backend), model routing |
| [CLI reference](docs/cli.md) | every command with flags and examples |
| [Appropriations](docs/appropriations.md) | the stolen — cited — research behind bandit: SoL-Pi's four mechanisms, Thompson sampling, event sourcing, and the full lineage |
| [Installation](docs/installation.md) | the OmO-style walkthrough: humans + LLM-agent steps, doctor checks, troubleshooting |
| [KISS discipline](docs/plans/kiss-discipline.md) | what is kept/frozen/forbidden — the measured-trigger rule that keeps the factory from overfitting |
| [Summoned voices](docs/plans/summoned-voices-plan.md) | the consult design: spawning researchers into the conversation |
| [Long-running harness design](docs/plans/long-running-harness-design.md) | the Goodhart-resistant governor: divergence monitors, floors, capping — with the full literature |

## Tests

89 tests, one command, no mocks of convenience — real stub transports, real card folders:

```bash
bun test
```

## Status

v0.1 — the loop, the consult thread, the summoned voices, the classifier seat, the dossier, the streaming wave view, the ledger, the adapters, and the panes are production-hardened on real work — including a factory run on bandit's own source, which found and fixed three of its own defects (the amend-requeue dead end, the gate's backtick false-red, and the transport's blind stall-killer) while the dossier narrated every round. See [docs/plans/kiss-discipline.md](docs/plans/kiss-discipline.md) for what's frozen and why, and [docs/installation.md](docs/installation.md) for the full install + LLM-agent walkthrough.

## License

MIT