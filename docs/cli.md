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
Live dashboard (2s refresh): running agent processes (pid, role, harness, model, start time), cards in flight with output growth, board counts, recent events. Ctrl+C exits.

### `bandit events`
The event log — the truth. Last 30 events with type and payload. Empty board + no events means the factory genuinely did nothing.

### `bandit board`
The kanban: card ids and titles per column.

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