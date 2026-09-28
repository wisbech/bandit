# CLI Reference

```
bandit <command> [args]
```

Every command operates on the `.bandit/` folder in the current directory. No global state, no server to manage.

## Factory lifecycle

### `bandit .`
Init (if needed) + start. The one-command entry point. In a TTY it runs the interactive picker:

```
Which agent?            default: opencode / opencode / pi / claude / …(installed harnesses)
Which model?            default / <live ollama catalog>
Which serfs do you want to SEE while it runs?   none / actor / critic / master / all
```

Choices persist to `config.json`. Panes auto-open in herdr for the serfs you picked (if herdr is running).

### `bandit init`
Scaffold `.bandit/` — board, serfs (actor/critic/master with prompts, identity, state), bundled harness profiles, config. Idempotent-refuses if `.bandit/` exists.

### `bandit start [flags]`
Run the factory loop over the board. Holds open watching for new cards when drained (heartbeat every 60s).

| Flag | Effect |
|---|---|
| `--agent <name>` | harness for headless runs (`opencode`, `pi`, `claude`, …); persists |
| `--model <provider/id>` | model override; persists (shape-agnostic: `ollama/glm-5.3-flash:cloud` etc.) |
| `--transport <profile>` | use a named harness profile from `.bandit/harnesses/`; persists |
| `--visible <list>` | `actor,critic` / `all` / `none` — which serfs get panes; persists |
| `--once` | one pass over the board, then exit (no watch mode) |
| `--yes` | skip interactive picker even in a TTY |

Only *missing* panes open on start — rejoining a live factory doesn't duplicate workers. A second `bandit start` on a running factory is a visitor: it joins, doesn't clash.

### `bandit task "title" [--accept "criterion"] ...`
Add a card to the backlog. Multiple `--accept` flags become the acceptance criteria that drive the verification gate.

```bash
bandit task "fix flaky login test" --accept "pytest tests/test_login.py passes 3x in a row"
```

## Observation

### `bandit watch`
The wave view, streaming: subscribes to `.bandit/events/` via fs.watch and renders on append (no poll repaint). Shows running agent processes (pid, role, harness, model, start time), wave rows per board column — stage, role, gate, output growth per in-flight card, with the last consult exchange (master>, critic>, summoned voices in magenta) — board counts, and a recent-events window. Ctrl+C exits.

### `bandit events`
The event log — the truth. Last 30 events with type and payload. Empty board + no events means the factory genuinely did nothing.

### `bandit board`
The kanban: card ids and titles per column. `--verbose` folds each in-flight card's projection line into the listing: stage, round, gate state, grader verdict, consult count — all read from events + frontmatter, nothing written.

### `bandit card <id>`
The dossier — one command that answers "what happened to this card?" Pure projection over existing state, every section citing its source file:
- **TIMELINE** — this card's events (`.bandit/events/`)
- **CONSULT** — `card/consult.md` rendered as a chat (master, critic, summoned voices)
- **GRADER** — per-round verdicts (`.bandit/grading/` + `critic.verdict` events), with ⚠ flags on grader/gate contradictions
- **ARTIFACTS** — the card folder's files with sizes (harness scratch folded to one line)

Unknown id → an events-only dossier, not a crash. Absent sections are stated, never silent.

### `bandit doctor`
Nine-point health check, exit `1` on failure (CI-safe, warnings return 0): **Board** (4 columns), **Events dir**, **Serfs** (organ prompts + summonable roles), **Transport** (resolves to a real command), **Harness binary** (on PATH), **Board lock** (stale vs live holder), **Decisions port** (optional; warn-only), **Budgets** (no frontier card over its own limit), **Event log** (the factory is breathing).

### `bandit serf`
Spawn a serf by hand — same folder discipline the loop uses, so hand-spawns are first-class crew:
```bash
bandit serf probe-quants --role researcher --prompt "Evaluate the drawdown claims" --card dogfood-muky64nw
bandit serf --list
```
Writes `serfs/<name>/` (prompt.md, serf.md, origin.md, journal/, outputs/, memory/, children/), a children/ registry entry under the binding parent, and a `serf.spawned` event. `--role` copies a template prompt (researcher/architect or any existing serf's); `--prompt` writes a mission; `--card` binds lineage. The loop's own spawns (specialists, summoned consult voices) land in the same registry.

### `bandit card <id>`
The dossier for one card — the complete story for someone who wasn't watching. A pure projection over existing state; nothing here writes.

- **TIMELINE** — this card's events from `.bandit/events/*.jsonl`, one line each: time · type · key payload.
- **CONSULT** — `consult.md` rendered as a chat transcript (master turns tagged, DECISION lines highlighted); states its absence when no consult was opened.
- **GRADER** — per-round verdicts joined from `critic.verdict` events + the canonical track record in `.bandit/grading/<card>.md`, plus the grader's seat runs (`.bandit/grading/<card>.seat-*.md`) as plumbing history.
- **ARTIFACTS** — every file in the card folder with sizes (root-relative paths, byte counts, notes). The harness's own scratch (`<card>/.bandit/tmp/`, the TMPDIR redirect) is folded to one counted line — `92706906 B … 613 file(s), folded` — so 600 bunx-cache files never bury the card's real state, while nothing is rendered invisible.

Every section header cites the file it came from. Unknown ids fail at the CLI with a pointer to `bandit board`; the events-only dossier is the renderer's own degradation for library/embedded use.

```bash
bandit card visibility-card-dossier-command-bandit-card-id-muky62ac
```

### `bandit confidence`
The confidence ledger — claims, corroboration depth, status. During bootstrap this is the governor; after convergence it feeds the bandit.

### `bandit bandit`
The Thompson-sampling governor: readiness (trusted measures, qualified levers) and posterior bars per lever (mean, α, β).

## Human-in-the-loop

### `bandit chat [role] [--agent <harness>]`
Walk into a serf's pane and talk. Roles: `actor`, `critic`, `master`. The serf lives in the loop — you type to it mid-run.

```bash
bandit chat critic                 # your terminal: switch to herdr pane <id>
bandit chat actor --agent claude   # side pane via a different harness, seeded with the serf's identity
```

### `bandit panes [roles] [--stop [idle|all|pane_id]]`
Manage visible serf panes in herdr. `bandit panes actor,critic` opens (or reuses) panes for those roles and injects their prompts. `--stop idle` applies thermal discipline: blocked/idle agents get stopped.

### `bandit harnesses [add <name> <command> [args...] [--protocol acp]]`
List harness adapter profiles (● marks the active one), or add a custom profile. See [harnesses.md](harnesses.md).

## Self-improvement

### `bandit refine [--force] [--history] [--rollback <ts>]`
Run a refiner pass (normally triggered automatically by failure signatures after the board drains): reads events, proposes edits to serf prompts/memory with cited evidence, snapshots, applies. Every pass is reversible.

```bash
bandit refine --history            # recent passes: timestamp, action, edit count
bandit refine --rollback 2026-09-18T06-58-11-972Z
```

## Measurement

### `bandit migrate`
Fold a v2 `.serf/` into `.bandit/` (cards → folders, sidecars folded, serfs passed through). `--dry-run` previews.

## Exit behavior

- `start` installs a SIGINT handler that clears `run.lock` — Ctrl+C never leaves a stale lock.
- A stale lock (dead pid) is auto-cleared on next start; a live lock opens visitor mode.
- Non-zero exits print the reason (missing `.bandit/`, v2 factory still running, unknown command) — nothing fails silently.

## Environment discipline

Serfs run with `TMPDIR` redirected into the project (`.bandit/tmp`) and are instructed: scratch files under the project, never `/tmp`; use the project venv (uv/bun); never install globally. A factory should leave a project cleaner than it found it.