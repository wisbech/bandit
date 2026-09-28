# Design — Visibility: waves, streaming, and the master-first interface (llm-space / OmO / Brigade lessons)

Status: DESIGN v3 (adopted after the Brigade/OmO/omo.dev survey + the principal's convergence ruling)
Date: 2026-09-28
Trigger chain: llm-space (inspect/replay/files-are-the-state) → OmO (waves view, herdr-DAG pane) → Brigade (room streaming, thin clients) → the principal's ruling: the master pane is the interface, serf views are telemetry, and bandit-on-bandit is the proof workload. "We have had problems that have only surfaced in production."

## 0. The convergence ruling (binding)

- **Master is the conversation; everything else is telemetry.** The human's daily surface is the master (`bandit chat master`), with the wave view live beside it. Per-serf herdr panes stay as the *fire escape* for debugging — not the front door.
- **Bandit runs on bandit before TFD depends on it.** The proof metric is falsifiable and written before running (§5).
- **The conversation continues until convergence** — the principal↔assistant exchange is the consult thread in action; the board records what it settles.

## 1. What the three references teach (settled)

**LLM Space v4** — the contract: every step inspectable, failed runs replayable, threads are files. Bandit satisfies the hard parts structurally (events = truth, cards = folders); it lacks a *reader*. The gap is projection, not machinery.

**OmO** — the wave view: topological batches of task nodes rendered as `state · role · model`, with progress per wave. Decoded, it's a two-level progress projection. For bandit the "waves" are the kanban columns + pipeline stages (`backlog → plan-consult → round n → gate → grader → review`). Nearly free over existing events.

**Brigade** — thin clients over one state, and Team Mode's streaming rooms ("products build their own UI without coupling to the runtime"). Their guard vocabulary (leases, budgets, restart recovery, "mentions never silently launch work", "never the agent judging itself") matches bandit's Goodhart boundaries. **Adopted:** the *client shape* — watch as a subscriber to the event stream, not a poller. **Rejected:** the gateway daemon itself — bandit's bet stays: events + folders are the state, every client is disposable. A long-lived stateful middleman is exactly the process-lifecycle complexity our production incidents came from.

**herdr** — demoted to the fire escape: `bandit panes` / `bandit chat <role>` remain the only interactive mid-flight surface ("what was this serf actually doing?"). Keep for debugging; not the daily interface.

## 2. TUI/UI survey — what to appropriate (KISS-filtered)

| Source | Appropriation | Status |
|---|---|---|
| OmO wave/DAG view | waves as rows, nodes as `stage · role · gate-color`, progress per wave — pure projection over events | **Build now** |
| Brigade streaming client | `watch` subscribes via fs.watch on `.bandit/events/` (incremental tail, render-on-append) instead of 2s poll-repaint | **Build now** |
| OpenCode transcript aesthetic | consult thread + dossier rendered as a chat (tool calls collapsed inline) — inside `bandit card` | **Build now** |
| Charm (bubbletea/lipgloss) | richer TUI without Electron — borders/scroll/mouse | **Frozen**: trigger = wave view needs layout raw ANSI makes painful (≥3 live-updating cards); dependencies are mechanisms too |
| LLM Space replay | step-through of finished runs | **Frozen**: trigger = manual replay through the dossier hurts ≥2× |
| Brigade rooms (threads/replies/mentions) | multi-human / multi-channel visibility | **Frozen**: trigger = a second client exists (e.g. Telegram-to-master) |
| Brigade Team-Mode task graphs | durable rooms + dependency joins | **Frozen**: trigger = factory tree ≥3 nodes |
| Brigade anti-slop detector | deterministic output gate, "never the agent judging itself" | **Frozen**: trigger = grading records exist (≥20 cards) |
| Electron/web dashboard | a viewer with its own state | **Forbidden** while files are the state |

## 3. Build-now (unchanged from v2, re-ranked under the ruling)

1. **`bandit card <id>` — the dossier.** One command: timeline (events), consult thread (rendered as a chat), grader verdicts per round, artifacts (with file sizes) — every line citing the file it came from. The master's tool as much as the human's.
2. **`bandit board --verbose`** — in-flight cards get one extra line: stage · round · gate · grader verdict · consult points.
3. **`watch` v2 — the wave view + streaming.** Wave rows per column/stage-group, nodes as `stage · role · gate`, plus the last few consult lines ("the conversation is the most interesting thing the factory does"). Subscribes to events via fs.watch; renders deltas, not repaints.

### The one-view sketch

```
┌─ BANDIT ─────────────────────────────────────────────────────┐
│ wave backlog · 1                                             │
│   ○ 012-kibitzer            backlog                          │
│ wave in-flight · 2                                           │
│   ✔ 010-replay-harness      done · gate green · grader 0.9   │
│   ▸ 011-drawdown-attack     round 2 · gate red · consult:amend│
│                                                              │
│ MASTER — last consult exchange:                              │
│   master: the plan skips evidence collection…                │
│   critic: DECISION: amend — add the evidence step            │
│                                                              │
│ events ▸ round.started(011) verification.red(011) …          │
└──────────────────────────────────────────────────────────────┘
```

Interaction model: the wave view is a *pane beside* the master conversation (herdr today, any client later) — not a combined TUI. Two clean separations stay separate; you talk to the master, the pane streams the factory.

## 4. The design constraint that makes this safe

Everything above is a **pure function over existing state** (events jsonl + card folders + `.bandit/grading/` + consult.md). No new writes, no new decisions, nothing to overfit. Interfaces are cheap to build and cheap to delete; mechanisms are neither (KISS ledger §5).

## 5. The proof (bandit-on-bandit, falsifiable before running)

`bandit init` in this repo. Seeded cards, in order:
1. **Visibility cards** — the dossier command, the streaming wave view (the §3 build items, executed *by the factory*).
2. **The dogfood card** — run the loop over the board and verify with the dossier alone.

**Proof metric, written before running:** a card goes backlog → done through the consult pipeline with zero manual fixes; `bandit card <id>` tells the complete story (timeline + consult + verdict) to someone who wasn't watching; when a production incident occurs, it is diagnosable from the dossier without opening jsonl. Three checks, all or nothing — same discipline as the F2F falsification targets.

## 6. What the enduser gets, concretely

Today: `bandit events | tail`, then open three folders, then squint at jsonl.
After: sit in the master pane, watch the wave view stream beside it, ask the master (or run `bandit card`) for the story of any card. The human walks the factory the way the loop does: cards, events, verdicts, consults — all files, all readable, one command per altitude.