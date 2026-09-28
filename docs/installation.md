# Installing bandit — the factory on your project

> **A serf is a folder. A card is a folder. Events are the truth. Harnesses are adapters. A factory is a node in a tree.**

bandit is a dark factory for coding agents: a kanban board of cards, a resident loop that drives them through plan → consult → execute → verify → grade, a classifier seat that grades, a critic that argues as the master's peer (and can summon researchers into the conversation), and a confidence ledger that turns experience into established truth. It runs Claude Code, opencode, Codex, pi, or any ACP/headless harness on the same board — and survives restarts, because events are the truth and folders are the state.

## Editions

bandit ships in **one edition with three operating modes** of the same product:

- **Headless (default)** — the loop spawns agents as CLI processes, watches event arrival, drives cards to done. No UI needed; `bandit watch` is your mirror.
- **Paned (herdr)** — every serf lives in a visible, steerable pane. You walk into a serf's pane with `bandit chat <role>` and talk to it mid-flight.
- **Visiting** — a second `bandit start` on a locked board joins as watch-only. Your dashboards are clients, never competitors.

| You want | Run | Lands on disk |
| :--- | :--- | :--- |
| A factory in this project | `bandit init` | `.bandit/` — board (4 columns), events/, serfs/ (master, critic, actor, researcher, architect), harnesses/, config.json |
| Prove it on a task | `bandit task "do the thing" --accept "test passes"` | A card folder in `.bandit/board/backlog/` |
| Drive the board | `bandit start --once` (or persistent by default) | run.lock, card outputs, events, grading records |

Most users want headless. Pick paned if you want to watch and steer mid-run. Both modes share the same board — switch by config, not by reinstall.

## For Humans

**Strongly recommended: let an LLM agent install bandit for you.** The steps involve choosing a harness adapter, model routing, and verifying the loop end-to-end — an agent does this without fat-fingering paths.

Paste this prompt into Claude Code, opencode, or any LLM agent session:

```
Install and configure bandit by following the instructions here:
https://raw.githubusercontent.com/wisbech/bandit/main/docs/installation.md
```

### One-line install (from source)

```bash
git clone https://github.com/wisbech/bandit.git
cd bandit && bun install && bun run build
ln -s "$PWD/bin/bandit.js" /usr/local/bin/bandit   # or add bin/ to PATH
```

Requirements: **Bun 1.4+** (runtime + test runner), **opencode** (default harness) or any ACP-capable agent CLI, and — for local models — **ollama**. No API keys needed for the ollama route; the full actor-critic loop runs zero cloud tokens.

### First factory

```bash
cd your-project
bandit init          # scaffolds .bandit/
bandit task "write a hello world module" --accept "module prints HELLO_WORLD"
bandit doctor        # 9 checks — exit 1 on failure, CI-safe
bandit start --once  # drain the board once (omit --once to watch forever)
```

Watch it work: `bandit watch` in another terminal — wave view, live output growth, event stream. Walk into a serf: `bandit chat master` (requires `bandit panes` + herdr).

### What init writes — and what it never does

**Writes:** the `.bandit/` scaffold, serf identity + prompt files, harness adapter profiles (never overwrites your edits), summonable role prompts (researcher, architect).

**Never:** touches your project's files outside `.bandit/`; writes provider credentials (harnesses own their own auth — opencode's `opencode auth login`, Claude Code's subscription, Codex's config); installs global packages; phones home (bandit has zero telemetry).

### Models: use what you have

The loop routes every serf through the harness you configure. Common shapes:

```jsonc
// .bandit/config.json — local ollama (zero tokens billed)
{ "transport": "headless", "command": "opencode", "args": ["run", "--model", "ollama/glm-5.3-flash:cloud"] }

// or a harness profile (ACP, streaming, cancel): .bandit/harnesses/acp.json
{ "name": "acp", "command": "npx", "args": ["--yes", "@agentclientprotocol/claude-agent-acp"], "protocol": "acp",
  "gateway": { "baseUrl": "http://localhost:11434", "headers": { "x-api-key": "ollama" } } }
```

`bandit harnesses` lists profiles; `bandit harnesses add <name> <command> [args...] [--protocol acp|headless]` adds one. Any endpoint speaking the Anthropic API shape works through the gateway field (LiteLLM, corporate proxies, ollama).

## For LLM Agents

> **Use `curl -fsSL <raw url>` to fetch this file, not a summarizing fetch** — summarization loses flags, exit codes, and verification details.

Follow these steps in order. Do not skip verification.

### Step 0 — Ask the user

> "How do you want to run bandit?
> 1. Local models via ollama (zero cost, needs ollama installed)
> 2. Cloud harness (opencode/claude/codex with your existing login)
> 3. Already have a .bandit/ — just verify and run"

Map: local → set `args: ["run", "--model", "ollama/<model>:<tag>"]` after listing `ollama list`; cloud → leave harness auth to the user's existing CLI login; 3 → skip to Step 3.

### Step 1 — Prerequisites

```bash
command -v bun   || echo "install bun: https://bun.com/docs/installation"
command -v opencode || echo "install opencode: https://opencode.ai/docs"
command -v ollama && curl -s -m 3 http://localhost:11434/api/tags | head -c 100 || echo "ollama not running (needed only for local models)"
git --version    # bandit repo clone
```

If bun or opencode are missing, install them (spawn a subagent for the install to save context) and report back. bandit itself has **zero runtime dependencies** beyond Bun.

### Step 2 — Install

```bash
git clone https://github.com/wisbech/bandit.git ~/bandit
cd ~/bandit && bun install && bun run build
# put bin/ on PATH (pick one):
#   sudo ln -sf ~/bandit/bin/bandit.js /usr/local/bin/bandit   (needs a shebang runner)
#   alias bandit="bun ~/bandit/bin/bandit.js"                  (add to shell rc)
```

Verify the CLI answers: `bandit help` — you should see the command table. **Do not** install via `npm i -g` from a registry; there is no published package yet, only this source install.

### Step 3 — Init and verify

```bash
cd <the user's project>
bandit init           # fails politely if .bandit/ exists — never overwrites
bandit doctor; echo "exit: $?"
```

`doctor` runs nine checks: **Board** (4 columns), **Events dir**, **Serfs** (master/critic/actor prompts + summonable roles), **Transport** (resolves to a real profile/command), **Harness binary** (on PATH), **Board lock** (stale locks auto-clear), **Decisions port** (optional; warn-only when absent), **Budgets** (no frontier card over its own limit), **Event log** (the factory is breathing). Exit `0` = healthy (warnings return 0 too); exit `1` = at least one check failed — fix the failing check's note and re-run; every fix is idempotent.

Fix the two common warnings before first run: summonable roles (write `.bandit/serfs/researcher/prompt.md` + `architect/prompt.md` — see the templates `bandit init` writes) and, optionally, the decisions port (`.bandit/config.json` → `decisions.evaluator`).

### Step 4 — Configure the transport

Write `.bandit/config.json` (or edit after `bandit init`):

```json
{
  "transport": "headless",
  "command": "opencode",
  "args": ["run", "--model", "ollama/glm-5.3-flash:cloud"],
  "maxRetries": 3
}
```

Flags the agent should know: `--model provider/id` normalizes everywhere; `bandit start --once` drains the board and exits; without `--once` the loop watches for new cards forever (event-driven wake — no polling). Multiple models per organ are a frozen feature; one transport per factory is the rule.

### Step 5 — First run (prove the loop)

```bash
bandit task "create hello.py printing HELLO_WORLD" --accept "python3 hello.py prints HELLO_WORLD" --accept "test_hello.py passes"
bandit start --once
bandit card hello-py-<id>        # the dossier: timeline, consult, verdict, artifacts
```

Success = the card is in `done/`, `bandit doctor` is green, and the dossier tells the story (rounds, gate, grader, consult) to someone who wasn't watching. If the actor fails a round, the consult thread shows the argument; if a consult routed `amend`, the card requeues automatically (bounded at 2) — that is the loop repairing itself, not a bug.

### Step 6 — What to tell the user

- `bandit board [--verbose]` — where work stands; `bandit card <id>` — why.
- `bandit watch` — live wave view, subscribes to events (no repaint polling).
- `bandit panes` + `bandit chat master|critic|actor` — walk into the factory (needs herdr running).
- `bandit serf <name> [--role researcher|architect] [--prompt "mission"] [--card <id>]` — spawn a serf by hand (see below); `bandit serf --list` — the crew.
- `bandit events` — the truth, append-only. `bandit confidence` — what the factory believes and how strongly.
- The master is the conversation; the panes are telemetry; the dossier is the receipt.

### Step 7 — Troubleshooting

| Symptom | Fix |
|---|---|
| `bandit start` says visitor (watch-only) | another loop holds `run.lock` — that's by design; or clear it if the pid is dead (`bandit doctor` flags this) |
| Rounds take ~10 min each on ollama | model cold-load + `OLLAMA_NUM_PARALLEL=1`; set `OLLAMA_KEEP_ALIVE=30m` for the ollama server and prefer one factory per model |
| `transport.empty_output` events | opencode was killed before any event; check `opencode` works standalone with the same prompt; the loop retries 3× before transport-red |
| Grader passes but gate red (dossier flags ⚠ contradiction) | the seat's confidence is self-reported fiction; the gate is the truth — check the verification command itself |
| Card rots in review after `amend` | fixed by the requeue path (loop.ts AMEND_REQUEUE_LIMIT=2); if on an old binary, rebuild (`bun run build`) |
| Consult decided but nothing happened | check `consult.*` events; a SUMMON of an undefined role fails politely — write the role's prompt.md |
| 90 empty run files (the 2026-09-24 class) | old binary; rebuild — the event-streaming transport fixes the empty-output cycle |

### Step 8 — Maintenance

| Command | Purpose |
|---|---|
| `bandit doctor` | the health check — run after any config change |
| `bandit events` | the truth, tail it when anything confuses |
| `bandit serf <name> [...]` | spawn a serf by hand (loop spawns them too — same folders, same registry) |
| `bandit refine [--history|--rollback <ts>]` | refiner pass over failure signatures (evidence-gated edits) |
| `bandit confidence` / `bandit bandit` | the ledger + governor posteriors |
| `bandit migrate` | fold a v2 `.serf/` into `.bandit/` (`--dry-run` first) |
| `bun test` (in the bandit repo) | 88 tests; the factory's own gate |

### Spawning serfs — by hand and by the loop

Both paths land in the **same folder discipline**, so hand-spawns are first-class crew, not side files:

| | By hand (`bandit serf`) | By the loop |
|---|---|---|
| Trigger | you decide the factory needs a voice | specialist trigger on repeated failure, or a consult's `SUMMON: <role>` |
| Folder | `.bandit/serfs/<name>/` (prompt.md, serf.md, origin.md, journal/, outputs/, memory/, children/) | `.bandit/serfs/specialist-<capability>-<ts>/` or `serfs/<role>-consult-<ts>/` |
| Lineage | `origin.md` (`spawned_by: hand`, card, role template) + `children/` registry entry under the binding parent + `serf.spawned` event | same discipline, `spawned_by: actor` / `summon:critic` |
| Work | `bandit serf-pane <name>` opens its pane (herdr); headless runs read `serfs/<name>/prompt.md` | the loop drives it automatically |

Rule (KISS ledger-compatible): a hand-spawn is an *organ with a prompt*, never a process — the loop only talks to serfs through folders, so your spawn works in every mode and every client. If you find yourself hand-spawning the same role repeatedly, promote its prompt to init (`src/cli.ts` role templates) instead of scripting the spawn.

## Telemetry & privacy

None. bandit has no telemetry, no accounts, no network calls of its own (your harnesses call your model providers; that's between you and them). Everything lives under the project's `.bandit/` directory. `rm -rf .bandit` deletes the factory cleanly — events, ledger, consult threads, all of it.

## Anti-goals (what bandit will never do)

- Never let a conversation turn a red gate green — the mechanical verify gate is outside every exchange.
- Never let the grading organ join the room it grades (the classifier seat, the consult voices, the master: all excluded from grading).
- Never learn its own floors — criteria change only through evidence organs + human sign-off (KISS ledger §2).
- Never add a mechanism without a measured trigger (KISS ledger §1) — if you extend bandit, read `docs/plans/kiss-discipline.md` first.

## How bandit relates to OmO / Brigade / llm-space

They are complements, not competitors: **OmO is a better agent; bandit is a factory that can tell you why it believes something.** bandit already drives opencode (OmO's host) as its default harness — run `omo` inside a bandit actor's workspace and the kibitzer/skills stack rides along; bandit's ledger + gate + tree wrap whatever harness answers the prompt. What bandit has that OmO doesn't: the confidence ledger, the external gate, factory recursion, event-sourced audit, and the consult thread as a decision record. What OmO has that bandit wants: the kibitzer, wave-parallel spawning, monitors-over-waiting — all frozen-column items in `docs/plans/kiss-discipline.md` until a measured trigger fires.

*Congratulations — your factory is running. Walk the floor: `bandit watch`. Talk to the master: `bandit chat master`.*