---
id: shrink-check
title: bandit shrink-check - a deletion card is a card whose verify is a net line count
verify: bun test ./tests/seed/shrink-check.check.ts
---
# bandit shrink-check - a deletion card is a card whose verify is a net line count

## Task
Make check-preserving deletion a first-class card type without touching the kernel: a verb that passes only
when the branch removes more lines than it adds under a path. A deletion card is then simply a card whose
`verify:` is e.g. `bun src/shrink.ts --base main` (or `bun src/cli.ts shrink-check --base main`); the judge's
normal project gates (`bun test`, `bunx tsc --noEmit` in `bandit.json`) keep every test green at the same time.
Because the judge runs `verify` from the candidate's tree, a deletion card ratifies `src/shrink.ts` as its
check path; so `src/shrink.ts` must run on its own and import only node builtins.

1. New file `src/shrink.ts`, importing ONLY `node:` builtins (no `./` or `../` imports, no packages), exporting exactly:

```ts
export type ShrinkReport = { added: number; deleted: number; net: number; files: number };
export function shrinkReport(repoDir: string, base: string, path?: string): ShrinkReport; // path defaults to "src"
export function shrinkMain(args: string[], repoDir?: string): number; // the verb; returns the exit code; repoDir defaults to process.cwd()
```

   and ending with `if (import.meta.main) process.exit(shrinkMain(process.argv.slice(2)));`, so
   `bun src/shrink.ts [--base <ref>] [--path <dir>] [--json]` behaves exactly like the verb in step 2.

   - Run `git diff --numstat <base>...HEAD -- <path>` in `repoDir` (three dots: changes since the merge base of `base` and HEAD, so later commits on `base` do not count). Use `execFileSync`/`spawnSync` with an argv array, no shell.
   - Each output line is `<added>\t<deleted>\t<file>`. A binary file shows `-\t-\t<file>`: skip it entirely (not in `added`, `deleted` or `files`).
   - `added`, `deleted`: sums; `files`: the number of non-binary lines; `net = added - deleted`.
   - When git exits non-zero (e.g. `base` does not resolve), throw an `Error`.

2. `shrinkMain(args, repoDir = process.cwd())` is the verb, returning the exit code (it prints, it does not call `process.exit`):
   - Arguments: `--base <ref>`, `--path <dir>` (default `src`), `--json`. A `--base` or `--path` with no value after it, or any other argument, is a usage error: print the usage to stderr and return 2.
   - Default base, when `--base` is not given: `main` if `git rev-parse --verify --quiet main^{commit}` succeeds, else `HEAD^` (HEAD's first parent).
   - The base must resolve (`git rev-parse --verify --quiet <base>^{commit}` exits 0); otherwise print an error to stderr and return 2. This includes a repo with no `main` and a single commit (no `HEAD^`).
   - Compute `shrinkReport(repoDir, base, path)`. Print `added <a> deleted <d> net <n> files <f>` (exactly that word order, single spaces; you may append ` (base <ref>)`). With `--json`, instead print `JSON.stringify({ added, deleted, net, files, base })` on ONE line, the last line of stdout.
   - Return 0 when `net < 0`, 1 when `net >= 0`.

   In `src/cli.ts`, add a `COMMANDS` entry `name: "shrink-check"`, usage `bandit shrink-check [--base <ref>] [--path <dir>] [--json]`, whose `fn` is `process.exit(shrinkMain(args))` (import it from `./shrink`).

3. Add nothing else: no event, no change to the judge, the board or `bandit.json`.

## Acceptance
- Temp git repos, branch `work` off `main`: deleting 6 lines and adding 2 under `src/` gives `{added: 2, deleted: 6, net: -4, files: 2}`, exit 0, and the text line `added 2 deleted 6 net -4 files 2`.
- Net zero (one line changed) and net positive exit 1, printing the numbers.
- Changes outside `--path` are ignored; `--path docs` measures `docs/` alone.
- Binary files (changed or new) are ignored and not counted in `files`.
- Lines added on `main` after the branch point do not count (three dots).
- No `--base`: `main` when it exists; without `main`, HEAD's first parent; with neither, exit 2.
- An unknown base exits 2 (and `shrinkReport` throws); `--base` or `--path` without a value, or an unknown argument, exits 2.
- `bun src/shrink.ts` with the same arguments gives the same output and exit codes, and `src/shrink.ts` has no import that is not `node:`.
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
Compression progress (Schmidhuber): a discovery is a change that deletes a lot while every check stays green. This
verb is the "deletes a lot" half; the project gates are the "every check stays green" half. See the "Deletion
cards" section of `seed/README.md`.
The change is outside the kernel: new `src/shrink.ts`, `src/cli.ts`.
Do not edit seed/, tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
