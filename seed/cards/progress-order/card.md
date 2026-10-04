---
id: progress-order
title: Pull where cost is falling - backlog order by recent improvement, opt-in
verify: bun test ./tests/seed/progress-order.check.ts
---
# Pull where cost is falling - backlog order by recent improvement, opt-in

## Task
Three pure functions in a new `src/progress.ts`, and one opt-in hook in `runLoop` (`src/loop.ts`).

**1. Create `src/progress.ts`** exporting exactly:

```ts
export type Pull = { lever: string; accepted: boolean; tokens: number };
export type LeverStat = { pulls: number; flat: number; lastCost: number | null; progress: number };
export function leverOf(card: { frontmatter: Record<string, string>; body: string }): string | null;
export function leverHistory(root: string): Array<{ card: string; lever: string; accepted: boolean; tokens: number }>;
export function leverProgress(history: Pull[]): Record<string, LeverStat>;
export function orderFrontier(
  cards: Array<{ id: string; lever: string | null }>,
  stats: Record<string, LeverStat>,
  opts?: { maxFlat?: number },
): { order: string[]; parked: string[] };
```

`leverOf`: MOVE the private `leverOf` and `slugify` from `src/loop.ts` into `src/progress.ts` unchanged in behaviour (frontmatter `lever:` slugified as `lever:<slug>`, else the first non-empty line under `## Lever` slugified and cut to 48 characters, else `null`), export `leverOf`, and import it in `src/loop.ts` where the old one was used. (`src/progress.ts` must not import `src/loop.ts`.)

`leverProgress(history)`: walk `history` in order, keeping one `LeverStat` per lever (start `{pulls: 0, flat: 0, lastCost: null, progress: 0}`). For each pull: `pulls += 1`; its cost is `tokens` when `accepted`, `Infinity` when not.
- PROGRESS when `accepted` and (`lastCost === null` or `cost < lastCost`): `progress = lastCost === null ? 1 : (lastCost - cost) / lastCost`; `flat = 0`; `lastCost = cost`.
- Otherwise the pull is FLAT: `flat += 1`; if it was accepted (not cheaper), `lastCost = cost` anyway; `progress` is left as it was. A pull that was not accepted never changes `lastCost` (its tokens are not a cost).
- So `lastCost` is the cost of the lever's most recent accepted pull, `progress` is the relative drop of its last progress pull, `flat` counts consecutive non-progress pulls. Levers that never appear are absent from the result.

`orderFrontier(cards, stats, { maxFlat = 3 } = {})`:
- `parked`: every card whose lever is non-null, in `stats`, and has `flat >= maxFlat`. Sorted by id.
- `order`: every other card, in three groups, concatenated:
  1. lever in `stats` with `progress > 0`: sorted by `progress` descending, ties by id;
  2. lever `null`, or lever not in `stats` (never pulled): sorted by id;
  3. lever in `stats` with `progress === 0`: sorted by id.
- Ties and groups sort by id with plain string comparison, whatever the input order.

`leverHistory(root)`: one entry per card that has at least one terminal event in `readEvents(root)` (`src/kernel/log.ts`). Terminal events: `card.completed`, `task.failed`, `acceptance.passed`, `acceptance.failed`.
- Order: by the log position of each card's LAST terminal event (a card that failed, was reopened and then completed is one entry, at its completion).
- `lever`: `leverOf(parseCard(dir))` where `dir = findCardDir(root, card)` (both from `src/kernel/card.ts`), wherever the card is on the board. Omit the card when the folder is gone or its lever is `null`.
- `accepted`: if the card has any `acceptance.passed`/`acceptance.failed` event, whether the latest of them is `acceptance.passed`; otherwise (shared mode, no judge) whether a `card.completed` event exists for it.
- `tokens`: `Number(frontmatter.lifetimeTokensUsed)`, or 0 when missing or not a number.

**2. Wire it into `runLoop`, opt-in.** In `src/loop.ts`, `runLoop` builds
`const frontier = [...mine, ...kernelCardsIn(root, "backlog").map((c) => c.id)];`.
Read `<config.root>/.bandit/config.json` (missing file or bad JSON = off). When it has `"order": "progress"`, replace the backlog part (and only it; `mine` stays first, unchanged):

```ts
const backlog = kernelCardsIn(root, "backlog");
const stats = leverProgress(leverHistory(root));
const { order, parked } = orderFrontier(backlog.map((c) => ({ id: c.id, lever: leverOf(c) })), stats);
for (const id of parked) {
  const lever = leverOf(backlog.find((c) => c.id === id)!)!;
  emit("card.parked", { card: id, lever, flat: stats[lever].flat });
}
// frontier = [...mine, ...order]
```

A parked card is not claimed and stays in `backlog`. `card.parked` is logged once per parked card per call of `runLoop` (one pass). Without `"order": "progress"` the frontier is exactly as today (id order, no `card.parked`, `leverHistory` not called).

## Acceptance
- `leverProgress` rows: first acceptance is progress 1; 1000 then 600 is progress 0.4; a failed pull after it is flat 1 with progress kept; same or dearer cost is flat (dearer becomes `lastCost`); 1000, 1500, 1200 is progress 0.2 (against the previous accepted cost); a progress pull resets flat; never accepted is `{pulls, flat: pulls, lastCost: null, progress: 0}`; a failed pull's tokens are ignored; interleaved levers are independent.
- `orderFrontier` rows: id order with no stats; progress descending; ties by id; parked at flat 3 by default; `maxFlat` 2 and 5; lever-less and never-pulled cards after progress and before known-flat levers; a lever with progress > 0 and flat 2 stays in the progress group; a parked lever parks all its cards.
- `leverHistory`: one entry per finished card in order of its last terminal event; frontmatter `lever: Alpha Beta` and a `## Lever` section `Alpha beta` are the same lever `lever:alpha-beta`; the judge's latest verdict wins over `card.completed`; cards without a folder or a lever are omitted; missing tokens are 0.
- With `"order": "progress"` and a prior log where `lever:flat` went flat three times, `lever:hot-path` fell 1000 -> 500 and `lever:first` was accepted once, `runLoop({once: true})` claims `f-first, c-hot, b-new, d-none, e-stuck` in that order (`card.claimed` events), logs one `card.parked {card: "a-flat", lever: "lever:flat", flat: 3}`, and leaves `a-flat` in backlog.
- Default config: claims in id order, nothing parked.
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
Compression progress (Schmidhuber): interestingness is the first derivative of compressibility. The bandit should
pull where cost per accepted card is falling, explore levers it has never pulled, and stop pulling levers that
stay flat. A "pull" here is a finished card; its cost is the card's `lifetimeTokensUsed` (the loop's `recordSpend`
writes it; events carry no token counts). `src/confidence.ts` (`rankLeversForPull`, `flatPulls`, "dead") is a
separate ledger; this card does not use or change it.
The change is outside the kernel: new `src/progress.ts`, and `src/loop.ts`. Kernel modules are imported, never edited.
Do not edit seed/, tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
