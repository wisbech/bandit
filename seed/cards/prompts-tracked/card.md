---
id: prompts-tracked
title: Serf prompts get a tracked home in prompts/
verify: bun test ./tests/seed/prompts-tracked.check.ts
---
# Serf prompts get a tracked home in prompts/

## Task
Two changes.

**1. Read the tracked prompt first.** In `src/runner.ts`, change `export function readSerfFolder(dir: string): SerfFolder` to `export function readSerfFolder(dir: string, root?: string): SerfFolder`. The serf's name is the last path segment of `dir` (as today, `dir.split("/").pop()`). When `root` is given and `join(root, "prompts", name, "prompt.md")` exists, `prompt` is that file's content; otherwise `prompt` is `join(dir, "prompt.md")` as today. When the tracked prompt exists, the `.bandit` `prompt.md` need not exist. `identity` (`serf.md`) and `state` are read from `dir` as today. In `runSerfOnCard` in the same file, call `readSerfFolder(opts.serfDir, opts.root)`.

**2. A verb to create the tracked copies.** In `src/cli.ts`, add an entry to the `COMMANDS` array: `name: "prompts"`, usage `bandit prompts export [--force]`.
- `bandit prompts export`: for every folder `<cwd>/.bandit/serfs/<name>/` that contains `prompt.md`, copy that file byte for byte to `<cwd>/prompts/<name>/prompt.md` (create the folders). If the target already exists, leave it untouched unless `--force` is given, in which case overwrite it. Print one line per serf (written or kept). Exit 0.
- Any other subcommand (or none): print the usage line to stderr and exit 2 (`process.exit(2)`).

Optional, not checked: `summonConsultVoice` in `src/loop.ts` could also prefer `prompts/<role>/prompt.md`.

## Acceptance
- `readSerfFolder(<root>/.bandit/serfs/actor, root).prompt` is the content of `<root>/prompts/actor/prompt.md` when that file exists, and of `.bandit/serfs/actor/prompt.md` when it does not.
- A serf with only `prompts/<name>/prompt.md` (no `.bandit` prompt) still reads.
- `runSerfOnCard({ serfDir, cardDir, root, transport, vars })` sends the rendered tracked prompt to the worker.
- `bandit prompts export` copies `master`, `critic`, `actor` prompts exactly, skips a serf folder with no `prompt.md`, exits 0.
- An existing `prompts/<name>/prompt.md` is kept without `--force` and overwritten with it.
- `bandit prompts bogus` exits 2.
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
`.bandit/` is git-ignored, so a prompt edit there cannot be reverted by git or seen in a diff (docs/plans/seed.md, Rule 4). `prompts/` at the project root is tracked.
The change is outside the kernel: `src/runner.ts`, `src/cli.ts`.
Do not edit tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
