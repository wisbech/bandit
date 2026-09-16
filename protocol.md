# BANDIT — The Agent Factory

> **A serf is a folder. A card is a folder. Events are the truth. Harnesses are adapters. A factory is a node in a tree.**
>
> Bandit is the third generation of the serf idea. It coordinates multiple agent
> harnesses (Claude Code, opencode, Codex, Pi…) as workers on a shared board,
> measures whether its work moves the needle, and governs its own confidence
> about what works. Factories compose recursively: a project can grow into a
> department, a department into a company — by mechanism first, and the
> organization becomes an emergent property of the tree.

## What bandit is

A dark factory where agents execute work, a GAN critic enforces quality, a
refiner improves the factory from its own history, and a confidence ledger
turns experience into established truth. Every artifact is a folder; every
exchange is events.

## The recursive factory tree

A factory is a node. Nodes spawn child factories the same way serfs spawn
children — through folders, with lineage:

```
.bandit/factory.md            # this node: scope, goal, levers, measures
.bandit/serfs/<name>/         # workers of THIS node
.bandit/children/<name>/      # child factories — each is a full bandit node
```

- **`serf factory init <name>`** creates a child node under `children/<name>/`
  with its own board, serfs, events, and goal folder — a full bandit with its
  own scope (a card, a workstream, a department).
- **Delegation flows down, results flow up.** A parent hands a child a scope
  folder (its own `goal/` + initial cards). The child runs its own loop, its
  own confidence ledger, its own refiner. The parent's only obligations:
  review the child's established claims (ledger deltas flow up as events) and
  hold the child's budget.
- **Overhead reduction is structural, not managerial:** the parent's board
  only sees the child's *summary claims* (established levers, measure
  deltas), never the child's card traffic. Attention is scoped by the tree —
  a node reasons over its own board plus its children's ledgers, nothing more.
- **Scope grows with the tree:** what starts as "project" becomes
  "department" (a node with 3 children) becomes "company" (a tree with
  budgets flowing down and measures flowing up). No new mechanism at scale —
  the same folders, one level deeper. An org chart emerges as the tree the
  agents actually built, not one anyone drew.
- **Lineage everywhere:** every child carries `origin.md` (spawned-by,
  problem, parent motivation). Any serf folder can *become* a factory root —
  the sentinel/fractal property, now the tree's growth mechanism.

This mirrors v2's folder-graph (children/, origin.md, fractal registry) —
bandit generalizes it from "serf spawns serf" to "factory spawns factory."

## The design decisions (v3 lessons, applied from day one)

1. **Event-sourced.** Events are the truth; folders are the projection. Replay repairs.
2. **Folder-per-serf.** Identity, prompt, state, journal, outputs, memory, children in one place.
3. **Card-as-folder.** Plans, outputs, verdicts, gate fingerprints travel with the card.
4. **Harness adapters, not subclasses.** One Runner interface; each runtime is a declarative profile. ACP is the universal spoke (Claude/Codex via official adapters, opencode via HTTP+SSE); herdr panes and headless are local adapters. Capability flags per adapter — never invent a control the harness didn't advertise.
5. **Critic is a serf** with its own verdicts/ history; plumbing failures retry the critic, never the actor.
6. **Evidence-gated everything.** Refiner edits cite evidence; deletes are retirements; snapshots make every pass reversible.
7. **Confidence ledger** (bucket-brigade → bandit governor when instruments converge). Established = probability, not a vibe.
8. **Levers + measures navigation.** A goal is discovered, not decreed; levers are hypotheses; measures are external-source instruments.
9. **No polling on the board.** fs.watch wakes the loop; process-exit events drive liveness; the only writes are holder-side heartbeats.
10. **Staleness is designed for** (v2's best lessons): stealable locks via heartbeat, TTL pruning, stall detection as backstop.
11. **Environment discipline.** TMPDIR redirected into the project; venv/uv/bun enforcement; no global installs.
12. **Panes are the primary human interface** (herdr), watch is the mirror, events are the audit.

## Harness adapters

```
.bandit/harnesses/
├── headless.toml      # spawn CLI, wait exit, gate
├── herdr.toml         # visible panes, steerable
├── acp-claude.toml    # @agentclientprotocol/claude-agent-acp (stdio JSON-RPC)
├── acp-codex.toml     # codex-acp adapter
├── opencode-http.toml # opencode HTTP+SSE (harness-remote style)
└── mcp-station.toml   # cowork stations (rowboat Harbor): agents enter via MCP
```

One adapter = one file: `{command, args, protocol: headless|acp|http|herdr, capabilities: {streaming, cancel, sessions, models}}`. Cards can name a harness; the factory resolves the profile. The factory owns identity + state; the harness owns its native session.

## Invariants

1. One factory per project-root **per node** — a tree may span many directories; each node locks only its own board.
2. Base protocol immutable; supplemental state editable with evidence.
3. Plumbing failures never punish the worker.
4. Budget is a hard stop; counters durable; budgets flow down the tree.
5. Verification runs in the declared container when one is set.
6. If a feature can't be explained as "a file a serf reads or writes," it doesn't go in.
7. Events are append-only; every state change is reconstructible from them.
8. Delegation flows down through folders; established truth flows up through ledger deltas. A parent never reaches into a child's board.