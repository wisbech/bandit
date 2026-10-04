---
id: port-guard
title: bandit guard - any host asks "may I edit these paths?" before it edits
verify: bun test ./tests/seed/port-guard.check.ts
---
# bandit guard - any host asks "may I edit these paths?" before it edits

## Task
Bandit's process (card, worker change, a judge the worker cannot edit, keep or discard, log) should be
pluggable into any host: a Claude Code mod, an opencode plugin, a git hook, CI, a shell script. This card adds
the first verb of that harness-neutral port: the guard. It answers, before an edit, what the judge would
reject after it (gate `protected-paths`). Argv in, one JSON object on the last stdout line, a meaningful
exit code. It reads files only; it never writes and never needs a `.bandit` folder or git.

1. New file `src/port.ts` exporting exactly:

```ts
export type GuardResult = { allowed: boolean; hits: string[]; protected: string[] };
export function protectedList(repoDir: string): string[];
export function guard(repoDir: string, paths: string[]): GuardResult;
```

   `protectedList(repoDir)` returns, in this order and without duplicates (keep the first occurrence):
   - every entry of `PROTECTED_PATHS` (import it from `./kernel/judge`; do not copy the list);
   - the `protected` array of `<repoDir>/bandit.json`, when that file exists and `parseBanditJson(raw, "bandit.json")`
     (from `./kernel/judge`) accepts it; a file that does not parse or does not validate adds nothing and is not an error;
   - every string in the `checkPaths` array of every `<repoDir>/checks/*.json` file, files in name order; a file that
     is not valid JSON or has no `checkPaths` array is skipped (not an error); files not ending in `.json` are ignored;
   - `checks/` (already in `PROTECTED_PATHS`; the dedupe keeps one).
   With no `bandit.json` and no `checks/`, the result is exactly `PROTECTED_PATHS`.

   `guard(repoDir, paths)`:
   - Normalise each path: an absolute path is made relative to `repoDir` (`path.relative(resolve(repoDir), p)`); a
     relative path is taken as relative to `repoDir` and normalised (`path.normalize`, so `./src/x.ts` is `src/x.ts`).
     A path whose relative form is empty, starts with `..`, or is still absolute is OUTSIDE the repo: it is never a hit.
   - `hits` = the normalised inside-repo paths that `protectedHits` (from `./kernel/judge`; do not reimplement the
     matching) reports against `protectedList(repoDir)`: an entry ending in `/` matches by prefix, any other entry
     exactly. Hits keep the input order; each hit is the normalised relative path.
   - `allowed = hits.length === 0`; `protected = protectedList(repoDir)`. The object has exactly these three keys.

2. In `src/cli.ts`, add a `COMMANDS` entry `name: "guard"`, usage `bandit guard [--json] [--repo <dir>] <path>...`:
   - Arguments: `--json`, `--repo <dir>` (default `process.cwd()`), and one or more paths. No path, `--repo` without a
     value, or any other argument starting with `--` is a usage error: print the usage to stderr, exit 2.
   - Compute `guard(repo, paths)`.
   - With `--json`: print `JSON.stringify(result)` on ONE line, the last line of stdout.
   - Without `--json`: print each hit on its own line on stdout and nothing else on stdout (messages, if any, go to stderr).
   - Exit 0 when `allowed`, 1 when there is any hit.
   - It must work in a directory with no `.bandit/` (do not call anything that scaffolds one) and must write nothing.

3. Add nothing else: no event, no change to the judge, the board or `bandit.json`.

## Acceptance
- `protectedList`: kernel list + `bandit.json` extras + every ratified check path; no duplicates; exactly the kernel list in a bare directory; an unparseable `bandit.json` or `checks/*.json` is skipped, never a throw.
- `guard`: a kernel path, a ratified check path and a `bandit.json` extra entry (file exactly, directory by prefix) are hits; an ordinary `src/` path is allowed; a mixed list reports only the protected ones, in input order; `./x` is normalised; an absolute path inside the repo is relativised; a path outside the repo (absolute, or `../...`) is allowed.
- The result has exactly `allowed`, `hits`, `protected`, and `protected` equals `protectedList(repoDir)`.
- `bandit guard`: exit 0 and empty stdout when allowed; exit 1 with one hit per line; `--json` prints the object as the last stdout line with the same exit codes; `--repo` works from another cwd; exit 2 on no paths, `--repo` without a value, an unknown flag.
- Neither the function nor the verb writes anything; no `.bandit` appears.
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
Owner's direction (5 Oct 2026): "Let us not target Claude only — make this simple process something that can be
pluggable in mods etc." The port is a handful of verbs, each "argv in, one JSON object on the last stdout line,
meaningful exit code", so any host plugs in as guard, worker or display without bandit knowing the host. This card
is the guard; `port-status` (display), `port-work` (worker) and `adapters` (thin host glue) are separate cards.
The guard is advisory for the host: the judge still decides (rule 1) and reads the list from the BASE, never from the
working tree; the guard reads the working tree because it answers before any commit exists.
Builds on `PROTECTED_PATHS`, `protectedHits` and `parseBanditJson` in `src/kernel/judge.ts`; kernel modules are
imported, never edited. The change is outside the kernel: new `src/port.ts`, `src/cli.ts`.
Do not edit seed/, tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
