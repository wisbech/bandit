---
id: adapters
title: adapters/ - thin host glue (git hook, Claude Code mod, CI) that only calls the port
verify: bun test ./tests/seed/adapters.check.ts
---
# adapters/ - thin host glue (git hook, Claude Code mod, CI) that only calls the port

## Task
Bandit's port is a handful of verbs (`bandit guard`, `next`, `submit`, `release`, `status`, `accept`), each "argv in,
one JSON object on the last stdout line, meaningful exit code". This card adds the first adapters: harness-specific
glue that CALLS those verbs and formats their answers. The adapters contain no logic beyond calling the port and
formatting its answer: no protected-path list, no verdict, no board reading. If an adapter needs a decision, it asks
a verb. The verbs themselves are other cards; this card does not need them to exist (its check uses stubs).

All files go under `adapters/`. Add NO file whose name contains `.test.`, `_test_`, `.spec.` or `_spec_` anywhere
under `adapters/` (bun's default `bun test` glob would run it as part of every gate). Change nothing under `src/`.

1. `adapters/README.md`: the contract on one page.
   - For each verb, a line or table row with its argv, its JSON shape and its exit codes:
     - `bandit guard [--json] [--repo <dir>] <path>...` -> `{ allowed, hits, protected }`; 0 allowed, 1 any hit, 2 usage.
     - `bandit next --json [--id <card>] [--lease-min N]` -> `{ id, title, task, acceptance, context, verify, workDir, branch, base, protected, leaseUntil }`; 0 a card, 3 empty backlog (`{"id": null}`), 2 error.
     - `bandit submit <id> --json [--message <m>]` -> `{ id, passed, sha, branch, gates: [{ name, exitCode }], ratified }`; 0 passed, 1 failed, 2 error.
     - `bandit release <id>` -> `{ id, released }`; 0, 2 not held.
     - `bandit status --json` -> `{ columns, cards: [{ id, title, column, verify, ratified, verdict, verdictSha, claimedBy }], lastEventTs }`; 0.
     - `bandit accept <card> --ref <branch|sha|pr>` -> the judge's verdict; 0 passed, 1 failed, 2 usage.
   - A section titled "Plug a new host in three steps": (1) guard before edits (call `bandit guard --json <path>` and
     refuse on `allowed: false`); (2) be a worker with `bandit next --json`, edit in `workDir`, then `bandit submit <id> --json`
     (or `bandit release <id>`); (3) draw with `bandit status --json`.
   - A table of the adapters below, each linking its folder.

2. `adapters/git/pre-commit` (POSIX `sh`, first line exactly `#!/bin/sh`, mode 0755) and `adapters/git/README.md`
   (install: copy to `.git/hooks/pre-commit`, or `git config core.hooksPath adapters/git`).
   - The bandit command is `$BANDIT`, default `bandit`; it may be several words (`BANDIT="bun /path/src/cli.ts"`), so
     expand it UNQUOTED where it is run.
   - When `BANDIT_GUARD_ALLOW=1`: print a warning to stderr that contains the words `warning` and `BANDIT_GUARD_ALLOW`
     (a human kernel change is being committed without the guard) and exit 0.
   - When `git diff --cached --name-only` prints nothing: exit 0.
   - Otherwise run the guard on exactly the staged paths, each path one argument (paths may contain spaces):
     `out=$(git diff --cached --name-only -z | xargs -0 $BANDIT guard)`, keep its exit status. Status 0: exit 0.
     Any other status (1 = hits; anything else = the guard could not run): print to stderr a line saying the commit is
     blocked, then the guard's output (the hits, one per line), then a line naming `BANDIT_GUARD_ALLOW=1` as the
     human override, and exit 1. A guard that cannot run blocks (fail closed).

3. `adapters/claude-code-mod/` - a Claude Code mod (a plugin whose `hooks/register.js` registers function hooks), plus
   `adapters/claude-code-mod/README.md` (load with `claude --plugin-dir adapters/claude-code-mod`; set the command with
   the `bandit` option).
   - `.claude-plugin/plugin.json`: `{ "name": "bandit-guard", "version": "0.1.0", "description": "...", "userConfig": { "bandit": { "type": "string", "title": "bandit command", "description": "Command that runs bandit, e.g. bandit or bun /path/to/bandit/src/cli.ts", "default": "bandit" } } }`.
     (The name must not start with `claude`, `anthropic` or `cc-plugin`: those are reserved.)
   - `hooks/hooks.json`: `{ "modules": ["./register.js"] }`.
   - `hooks/register.js`: an ES module with NO `import` and no `require` (a mod reaches processes only through `$`).
     It exports `register(on, options)`:
     - `const cmd = String(options?.bandit || "bandit").trim().split(/\s+/)`.
     - Register `on('tool.call', { tool: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] }, async ($, e, next) => { ... })`.
       The path is `e.file_path` (`e.notebook_path` for NotebookEdit). If there is no path string, `return next(e)`.
     - `const cwd = await $.session.cwd()`, then
       `const r = await $.process.run([...cmd, 'guard', '--json', '--repo', cwd, path], { cwd })` -> `{ exitCode, stdout, stderr }`.
     - Parse the last non-empty line of `r.stdout` as JSON. When it parses and `allowed === true`: `return next(e)`
       (the same event object, unchanged).
     - When it parses and `allowed === false`: return `{ deny: 'bandit guard: <path> is protected (<hits joined by ", ">). The judge rejects any change to it; leave it to a human.' }`
       without calling `next`.
     - When `$.process.run` throws, or the output does not parse, or `allowed` is not a boolean: return
       `{ deny: 'bandit guard could not run (<reason>); refusing the edit. Set the bandit option of the bandit-guard mod.' }`
       without calling `next` (fail closed).
     - Every other tool is untouched: the matcher keeps the hook from running for it, so no process is started.

4. `adapters/ci/github-accept.yml` (a GitHub Actions workflow template) and `adapters/ci/README.md` (copy to
   `.github/workflows/`; put `bandit-card: <id>` on its own line in the PR body). Exactly this shape:

```yaml
name: bandit accept
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
jobs:
  accept:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      - id: card
        env:
          PR_BODY: ${{ github.event.pull_request.body }}
        run: |
          id=$(printf '%s\n' "$PR_BODY" | sed -n 's/^bandit-card:[[:space:]]*\([A-Za-z0-9._-]*\)[[:space:]]*$/\1/p' | head -n 1)
          if [ -z "$id" ]; then echo "::notice::no bandit-card: line in the PR body; skipping bandit accept"; fi
          echo "id=$id" >> "$GITHUB_OUTPUT"
      - if: steps.card.outputs.id != ''
        env:
          CARD: ${{ steps.card.outputs.id }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          BASE_REF: ${{ github.event.pull_request.base.ref }}
          BANDIT_CARDS_DIR: seed/cards
        run: |
          git branch -f main "origin/$BASE_REF"
          if [ ! -e ".bandit/board/backlog/$CARD/card.md" ]; then mkdir -p .bandit/board/backlog && cp -R "$BANDIT_CARDS_DIR/$CARD" .bandit/board/backlog/; fi
          bun src/cli.ts accept "$CARD" --ref "$HEAD_SHA"
```

   Why each line: the PR body and every `${{ }}` value reach the script through `env`, never interpolated into a
   `run:` script (script injection); `git branch -f main` makes the PR's base the judge's base (the judge reads
   `bandit.json` and `checks/` from `main`); the card folder is put on the board because `accept` finds the card there.
   If `main` is the checked-out branch, `git branch -f` fails: the checkout is the PR's merge commit (detached), so it is not.

## Acceptance
- `adapters/README.md` names all six verbs with their JSON fields and exit codes and has the "three steps" section; each adapter folder has a README; no `*.test.*`/`*.spec.*` file under `adapters/`.
- With a fake `bandit` stub as `$BANDIT` in a temp git repo using `adapters/git` as hooks path: staging `src/kernel/...` blocks the commit (non-zero, HEAD unchanged, the hit printed); staging ordinary files (one with a space in its name) passes and the stub received each staged path as one argument; a two-word `$BANDIT` works; `BANDIT_GUARD_ALLOW=1` commits and prints the warning; a missing bandit blocks; a staged deletion is guarded too.
- The mod, driven without Claude Code (a fake `on` that captures handlers and applies matchers, a fake `$` whose `process.run` is stubbed): Edit/Write on an allowed path call `next(e)` with the same event after exactly one run of `[...cmd, "guard", "--json", "--repo", cwd, path]` with `{ cwd }`; a refused path returns `{ deny }` naming the hit and never calls `next`; a guard that fails to run or prints no JSON denies; Read, Bash and Grep pass through with no process run; `options.bandit` of two words changes the argv; the manifest has the `bandit` userConfig option and `hooks.json` lists `./register.js`; `register.js` has no import.
- The workflow template matches the shape above (text-level check: `on:`, `pull_request`, `fetch-depth: 0`, `setup-bun`, `bandit-card:`, `::notice`, the PR body only through `env`, `git branch -f main "origin/$BASE_REF"`, `bun src/cli.ts accept "$CARD" --ref "$HEAD_SHA"`).
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
Owner's direction (5 Oct 2026): "Let us not target Claude only — make this simple process something that can be
pluggable in mods etc." The port verbs are the contract; adapters are disposable glue per host, so a new host costs a
page of glue, not a change to bandit. Claude Code mod facts used here, from code.claude.com/docs/en/plugins/mods
(overview, events, reference, test), as of Claude Code v2.1.289:
- Layout: "`.claude-plugin/plugin.json`", "`hooks/hooks.json`" with "`modules`: an array with one path, relative to this file, to the hooks module", and the hooks module "Exports `register(on, options)`"; "`options` holds the values of the `userConfig` fields the manifest declares, with defaults filled in".
- Handler: "It receives three arguments: the mods API as `$`, the event as `e`, and the next handler as `next`"; matcher: "A field can be a value, an array of allowed values, or a regular expression".
- Event: "`tool.call` | A tool is about to run | `next(e)`, `{ deny: reason }`, or `{ result }`"; "`e.tool` is the tool's name and the tool's arguments are fields of `e`"; the docs' own Edit/Write example reads `e.file_path`.
- Refusal: "return a result without calling `next`" ... "`return { deny: '...' }`" — "Claude reads the `deny` text as the tool's result, so write it as an instruction Claude can act on."
- Process: "`$.process` | `run`, `spawn`", used as `await $.process.run(['git', 'branch', '--show-current'])` with `.stdout` and `.exitCode`; the test kit's stub shows "`e.argv` is the argument list and `e.init` holds `cwd` and `timeoutMs`", i.e. `run(argv, { cwd })`.
- `$.session` lists a `cwd` method; the docs do not show its return value, so `await` it (works for a value or a promise). `NotebookEdit`'s `notebook_path` and `MultiEdit` are Claude Code tool facts not shown on the mods pages; the check covers Edit and Write only.
- The docs' official test kit (`claude plugin test`, `import ... from 'claude-code/testing'`) runs only under the `claude` CLI, so this card's check drives `register` with fakes instead; do not add a `.test.ts` under `adapters/` for it.
`port-guard`, `port-status` and `port-work` are separate cards (the verbs); this card depends on none of them.
The change is outside the kernel: new files under `adapters/` only.
Do not edit seed/, tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
