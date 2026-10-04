---
id: port-work
title: bandit next / submit / release - any external harness can be the worker, judged by the kernel
verify: bun test ./tests/seed/port-work.check.ts
---
# bandit next / submit / release - any external harness can be the worker, judged by the kernel

## Task
Today only bandit's own loop can drive a card through claim, isolated worktree, keep, judge and exit. This card adds
the worker side of the harness-neutral port: three verbs that let ANY harness (a Claude Code session, opencode, a
human in a shell, CI) take a card, work in its worktree and hand it back to the kernel judge. Each verb: argv in, one
JSON object on the last stdout line, a meaningful exit code. The verbs REUSE the loop's functions (`claimCard`,
`openWorktree`, `keepWorktree`, `discardWorktree`, the kernel `acceptRef`, `moveCard`); they reimplement none of them.

### The hold (why the loop leaves a port card alone)
`claimCard` records the claimant as `{ pid, startedAt }` of the calling process, and `runLoop` reclaims an in-progress
card whose claimant is dead. `bandit next` is a short process, so its pid dies at once. The port therefore records a
LEASE right after the claim, and the loop honours it. Rule, exactly:

> An in-progress card is HELD BY THE PORT when its latest `card.claimed` event and its latest `port.next` event have
> the same `pid` and the same `startedAt`, and that `port.next`'s `leaseUntil` (ISO time) is later than now.

A held card is neither reclaimed nor worked by the loop. When the lease has passed it is an ordinary dead claim and the
loop reclaims it as today. No kernel change is needed: the reclaim decision lives in `src/loop.ts`.

1. New file `src/port-work.ts` (not `src/port.ts`: another card creates that file), importing only node builtins,
   `./kernel/card`, `./kernel/log`, `./kernel/judge` and `./isolation`. Export exactly:

```ts
export class PortError extends Error { constructor(message: string, public code: 2 | 3 = 2) { super(message); } }
export type NextCard = {
  id: string; title: string; task: string; acceptance: string; context: string; verify: string | null;
  workDir: string; branch: string; base: string; protected: string[]; leaseUntil: string;
};
export type SubmitResult = { id: string; passed: boolean; sha: string; branch: string; gates: { name: string; exitCode: number }[]; ratified: boolean };
export function portProtected(repoDir: string): string[];
export function portLease(root: string, id: string): { pid: number; startedAt: string; leaseUntil: string; base: string; workDir: string; branch: string } | null;
export function heldByPort(root: string, id: string, now?: number): boolean;
export function portNext(root: string, opts?: { id?: string; leaseMin?: number }): NextCard | null;
export async function portSubmit(root: string, id: string, opts?: { message?: string }): Promise<SubmitResult>;
export function portRelease(root: string, id: string): void;
```

   - `portProtected(repoDir)`: `PROTECTED_PATHS` (from `./kernel/judge`), then the `protected` array of
     `<repoDir>/bandit.json` when `parseBanditJson` accepts it, then every `checkPaths` entry of every
     `<repoDir>/checks/*.json` that parses (others skipped); no duplicates. (The `port-guard` card builds the same list
     in `src/port.ts`; keep this one local so the cards stay independent.)
   - `portLease(root, id)`: the latest `port.next` event for the card, as its `pid` (number), `startedAt`, `leaseUntil`,
     `base`, `workDir`, `branch`; `null` when there is none. `heldByPort(root, id, now = Date.now())`: the rule above,
     with `latestClaim(root, id)` from `./kernel/card` as the latest claim, and the card in `in-progress`
     (`.bandit/board/in-progress/<id>/card.md` exists).
   - `portNext(root, { id, leaseMin = 120 })`:
     - Candidates: with `id`, that card only, and it must be in backlog (else `PortError("card <id> is not in backlog")`, code 2);
       without, `cardsIn(root, "backlog")` in id order. Take the first whose `claimCard(root, cardId)` returns true.
       None left (or an empty backlog): return `null`.
     - `openWorktree(root, cardId)` (always: the port ignores `isolationMode`). If it throws, put the card back
       (`moveCard(root, cardId, "in-progress", "backlog")`), log `port.released { card, reason }`, and throw `PortError`.
     - `leaseUntil = new Date(Date.now() + leaseMin * 60_000).toISOString()`.
     - Log `appendEvent(root, "port.next", { card, workDir, branch, base, holder: "port", pid, startedAt, leaseUntil })`
       where `pid`/`startedAt` are `self()` from `./kernel/card` (the claimant `claimCard` just recorded).
     - Return the `NextCard`: `title` = frontmatter title or the id; `task`, `acceptance`, `context` = the text of the
       card body's `## Task`, `## Acceptance`, `## Context` sections (from the line after the heading up to the next
       line starting with `## ` or the end), trimmed, `""` when the section is missing; `verify` = frontmatter `verify`
       or `null`; `workDir`, `branch`, `base` from `openWorktree`; `protected = portProtected(root)`; `leaseUntil`.
   - `portSubmit(root, id, { message })`:
     - Unknown card, card not held by the port (`latestClaim` and `portLease` do not match by pid and startedAt, or the
       card is not in `in-progress`), or no worktree directory: throw `PortError` (code 2) and touch nothing. The lease's
       expiry does not block submit; a reclaim (which changes the latest claim) does.
     - Nothing to submit: `git status --porcelain` in the worktree prints nothing AND the worktree's `HEAD` equals the
       lease's `base` -> throw `PortError("nothing to submit")` and touch nothing (worktree, column and lease stay).
       A commit the host made itself in the worktree counts as a change.
     - `keepWorktree(root, id, message ?? "bandit: <id> <title>")`; an `error` -> `PortError`, card stays held.
     - `sha` = `git rev-parse refs/heads/<branch>` in root. Judge: `acceptRef({ root, cardId: id, ref: branch, base: lease.base })`
       from `./kernel/judge` (the kernel judge, as the loop calls it; not `src/accept.ts`). If it throws: move the card
       to review, log `task.failed { card, reason: "judge", branch, error }`, throw `PortError`.
     - Passed: `moveCard(root, id, "in-progress", "done")`, then `appendEvent(root, "card.completed", { card: id, verdict: sha })`.
       Failed: `moveCard(root, id, "in-progress", "review")`, then `appendEvent(root, "task.failed", { card: id, reason: "judge", branch, sha, gates: [{ name, exitCode, argv }] })`.
       The branch stays in both cases. A `moveCard` that returns false: log `card.claim_lost { card, to }` and throw `PortError`.
     - Return `{ id, passed, sha, branch, gates: gates.map(({ name, exitCode }) => ({ name, exitCode })), ratified }`.
   - `portRelease(root, id)`: not held (same test as submit) -> `PortError` code 2. Otherwise `discardWorktree(root, id)`,
     `moveCard(root, id, "in-progress", "backlog")`, `appendEvent(root, "port.released", { card: id, branch })`.

2. `src/loop.ts`, `runLoop`, the frontier loop over in-progress cards: before the reclaim branch, skip a card for which
   `heldByPort(root, c.id)` is true (import it from `./port-work`), so the branch reads in effect
   `if (mine) ... else if (heldByPort(root, c.id)) { /* the port holds it */ } else if (!claim || !claimantAlive(claim)) reclaimCard(...)`.
   Change nothing else in the loop.

3. In `src/cli.ts`, three `COMMANDS` entries, all with `root = process.cwd()`; each prints its JSON object as ONE line,
   the last line of stdout, when `--json` is given (a short human line otherwise); errors go to stderr.
   - `next`: usage `bandit next [--json] [--id <card>] [--lease-min N]`. No `.bandit/board`: exit 2. `--id` or
     `--lease-min` without a value, a `--lease-min` that is not a number >= 0, an unknown flag: exit 2. A card: print
     the `NextCard`, exit 0. Nothing to claim: print `{"id":null}`, exit 3. `PortError`: exit 2.
   - `submit`: usage `bandit submit <id> [--json] [--message <m>]`. No id: exit 2. Print the `SubmitResult`; exit 0
     when passed, 1 when failed, 2 on `PortError` or any other error.
   - `release`: usage `bandit release <id> [--json]`. Exit 0 (print `{"id":"<id>","released":true}`), 2 on errors.

## Acceptance
- `next` in a temp git repo with a temp board: claims the first backlog card in id order (or `--id`), prints every `NextCard` key with the card's task/acceptance/context, a real worktree at `.bandit/worktrees/<id>` on branch `bandit/<id>` at the base sha, and `protected` containing the kernel list and the repo's `bandit.json` extras; logs one `card.claimed` and one `port.next` (same pid and startedAt, `holder: "port"`, lease ~2 h, or `--lease-min`); works when `.bandit/config.json` says `"isolation": "shared"`; an empty backlog exits 3 with `{"id": null}`; a card not in backlog exits 2.
- `submit` after writing a file in the worktree with a passing verify: exit 0, `bandit/<id>` holds one commit on the base with `--message`, `acceptance.passed` then `card.completed { verdict: sha }`, card in done. A host's own commit in the worktree is judged the same way.
- Failing verify: exit 1, card in review, `task.failed` reason `judge`, no `card.completed`, branch kept. A change under a `bandit.json` `protected` entry fails with gate `protected-paths`.
- Nothing changed: exit 2, card still in progress with its worktree, no judge run; a later real change submits. Unknown card, a backlog card, an in-progress card the port did not take, no id: exit 2, nothing moves.
- `release`: card back in backlog, worktree and branch gone, `port.released`; the card can be taken again; release of a card the port does not hold exits 2.
- A `runLoop({ once: true })` started after `bandit next` has exited neither reclaims nor works the held card (it works the other backlog card), and the host can still submit afterwards. With `--lease-min 0` the expired lease is reclaimed by the loop as any dead claim.
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
Owner's direction (5 Oct 2026): "Let us not target Claude only — make this simple process something that can be
pluggable in mods etc." Bandit's process is card -> worker change -> a judge the worker cannot edit -> keep or discard
-> log; this card opens the worker seat to any host. The judge, the claim and the log stay the kernel's (rules 1-3):
the port only calls them. Why a lease and not a different claimant: `claimCard` takes the claimant from the calling
process and `latestClaim` reads only `pid`/`startedAt`, so a port claim cannot carry a holder without a kernel change;
the lease is a separate `port.next` event that names the claim it extends, and the loop (outside the kernel) honours it.
`port-guard`, `port-status` and `adapters` are separate cards; this one depends on none of them.
Builds on `src/kernel/card.ts`, `src/kernel/judge.ts`, `src/kernel/log.ts`, `src/isolation.ts` and the reclaim branch of
`runLoop` in `src/loop.ts`. The change is outside the kernel: new `src/port-work.ts`, `src/loop.ts` (one condition),
`src/cli.ts`.
Do not edit seed/, tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
