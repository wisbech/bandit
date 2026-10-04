---
id: port-status
title: bandit status --json - one read-only snapshot any pane, status line or dashboard can draw
verify: bun test ./tests/seed/port-status.check.ts
---
# bandit status --json - one read-only snapshot any pane, status line or dashboard can draw

## Task
The display verb of the harness-neutral port: one JSON object describing the board, what the judge said about each
card, and who holds the cards in progress. A host draws from it and never parses the log itself. Read-only.
The proof-only rule matters here: a card shows `verdict: "passed"` ONLY when the judge logged it.

1. New file `src/port-status.ts` (not `src/port.ts`: another card creates that file) exporting exactly:

```ts
export type Column = "backlog" | "in-progress" | "review" | "done";
export type CardStatus = {
  id: string; title: string; column: Column; verify: string | null; ratified: boolean;
  verdict: "passed" | "failed" | null; verdictSha: string | null; claimedBy: { pid: number } | null;
};
export type BoardStatus = { columns: Record<Column, string[]>; cards: CardStatus[]; lastEventTs: string | null };
export function status(root: string): BoardStatus;
```

   `status(root)` (root is both the board root, containing `.bandit/`, and the repo dir, containing `checks/`):
   - `columns`: for each of `backlog`, `in-progress`, `review`, `done` (all four keys always present), the ids of
     `cardsIn(root, column)` from `./kernel/card`, in that order (id order; hidden `.<id>.<pid>` folders are not cards).
   - `cards`: one row per card, columns in the order above, cards in `cardsIn` order within a column:
     - `id`; `title` = frontmatter `title`, or the id when there is none; `column`;
     - `verify` = frontmatter `verify` (string), or `null` when there is none;
     - `ratified` = `<root>/checks/<id>.json` exists (do not read it);
     - `verdict`, `verdictSha`: take the events of `readEvents(root)` (from `./kernel/log`, log order) with
       `type` `acceptance.passed` or `acceptance.failed` and `card === id`; the LAST one decides: `"passed"` or
       `"failed"`, and its `sha` (as a string). None: both `null`. No other event type counts: not `card.completed`
       (even one carrying a `verdict` field), not `acceptance.started`, not `task.failed`.
     - `claimedBy`: for a card in `in-progress`, `{ pid }` from the LAST `card.claimed` event for it (`Number(e.pid)`);
       `null` when there is none, and `null` for cards in every other column.
     - Each row has exactly these eight keys.
   - `lastEventTs`: the `ts` of the last event of `readEvents(root)`, or `null` when there are none.
   - Read the log once per call. Write nothing: no event, no folder. With no `.bandit/` at all the result is four empty
     columns, `cards: []`, `lastEventTs: null`, and no `.bandit/` is created (do not call `mkdirSync`, `appendEvent`,
     or anything from `src/loop.ts` that scaffolds).

2. In `src/cli.ts`, add a `COMMANDS` entry `name: "status"`, usage `bandit status [--json]`, with `root = process.cwd()`:
   - `--json`: print `JSON.stringify(status(root))` on ONE line, the last line of stdout.
   - Without `--json`: a compact table, one line per card: column, id, verdict (`-` when null), `ratified` or `-`,
     and `pid <n>` when claimed; then one line `last event <ts>` (or `no events`). Free format beyond naming every card id.
   - Exit 0 in both modes, also with no `.bandit/`.

3. Add nothing else: no event type, no change to the judge, the board or the loop.

## Acceptance
- A synthetic board (cards in all four columns, a hidden claim in flight, ratified checks for two cards, a log written through the kernel): `columns` lists ids per column in id order and the hidden folder is not a card; `cards` follows column order then id order; every row has exactly the eight keys.
- `title` falls back to the id; `verify` is the frontmatter value or `null`; `ratified` follows `checks/<id>.json`.
- `verdict`/`verdictSha` follow the latest `acceptance.passed|failed` only: failed-then-passed is `passed` with the second sha, passed-then-failed is `failed`; a later `acceptance.started` changes nothing.
- Proof only: a card in `done` with `card.completed` (with or without a `verdict` field) and no judge event has `verdict: null`.
- `claimedBy` is `{ pid }` of the latest claim (after a reclaim, the new pid) for in-progress cards, `null` elsewhere.
- `lastEventTs` is the last event's `ts`; empty board and no `.bandit/`: the empty status, and no `.bandit/` is created.
- `bandit status --json` prints exactly `status(root)` as its last line; `bandit status` names every card; both exit 0 and append no event.
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
Owner's direction (5 Oct 2026): "Let us not target Claude only — make this simple process something that can be
pluggable in mods etc." The port is a handful of verbs, each "argv in, one JSON object on the last stdout line,
meaningful exit code"; this card is the display side (a Claude Code pane, an opencode status line, a tmux status, a
web dashboard all draw from the same JSON). Rule 1 ("nothing counts until the judge says so") is why `verdict` reads
only the judge's events. `port-guard`, `port-work` and `adapters` are separate cards; this one depends on none of them.
Builds on `cardsIn` in `src/kernel/card.ts` and `readEvents` in `src/kernel/log.ts`; kernel modules are imported, never
edited. The change is outside the kernel: new `src/port-status.ts`, `src/cli.ts`.
Do not edit seed/, tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
