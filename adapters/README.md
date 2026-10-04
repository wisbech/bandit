# adapters

Bandit's port is a handful of verbs. Each takes argv, prints one JSON object on the last stdout line, and exits with a
meaningful code. An adapter is thin, disposable glue for one host (git, Claude Code, CI, ...) that CALLS these verbs and
formats their answers. It holds no protected-path list, no verdict and no board reading: if it needs a decision, it asks a verb.

## The port

| Verb | JSON on the last stdout line | Exit codes |
| --- | --- | --- |
| `bandit guard [--json] [--repo <dir>] <path>...` | `{ allowed, hits, protected }` | 0 allowed, 1 any hit, 2 usage |
| `bandit next --json [--id <card>] [--lease-min N]` | `{ id, title, task, acceptance, context, verify, workDir, branch, base, protected, leaseUntil }` | 0 a card, 3 empty backlog (`{"id": null}`), 2 error |
| `bandit submit <id> --json [--message <m>]` | `{ id, passed, sha, branch, gates: [{ name, exitCode }], ratified }` | 0 passed, 1 failed, 2 error |
| `bandit release <id>` | `{ id, released }` | 0 released, 2 not held |
| `bandit status --json` | `{ columns, cards: [{ id, title, column, verify, ratified, verdict, verdictSha, claimedBy }], lastEventTs }` | 0 |
| `bandit accept <card> --ref <branch\|sha\|pr>` | the judge's verdict | 0 passed, 1 failed, 2 usage |

## Plug a new host in three steps

1. **Guard before edits.** Call `bandit guard --json <path>` before a write and refuse on `allowed: false`.
2. **Be a worker.** Take a card with `bandit next --json`, edit in its `workDir`, then `bandit submit <id> --json`
   (or `bandit release <id>` to give it back).
3. **Draw the board.** Read `bandit status --json` and render it however the host likes.

## Adapters

| Adapter | Host | What it does |
| --- | --- | --- |
| [git](git/) | git | `pre-commit` hook: runs `bandit guard` on the staged paths and blocks the commit on any hit |
| [claude-code-mod](claude-code-mod/) | Claude Code | mod that runs `bandit guard` before Edit/Write and denies protected paths |
| [ci](ci/) | GitHub Actions | workflow template: runs `bandit accept` on a PR that names its card |
