---
id: cost-report
title: bandit cost - cost per accepted card from the log
verify: bun test ./tests/seed/cost-report.check.ts
---
# bandit cost - cost per accepted card from the log

## Task
Add a report computed only from data that exists today: the event log and card frontmatter.

1. New file `src/cost.ts` exporting `costReport(root: string): CostReport` where
   `CostReport = { cards: number; accepted: number; rounds: number; tokens: number; costPerAccepted: number | null; results: { id: string; accepted: boolean; rounds: number; tokens: number }[] }`.
   - Read events with the kernel `readEvents(root)` from `src/kernel/log.ts` (import it; do not change it).
   - Reported cards: every distinct `card` value of a `round.started`, `acceptance.passed` or `acceptance.failed` event. Sort `results` by id.
   - `rounds`: the number of `round.started` events for the card.
   - `accepted`: true when the card's latest `acceptance.passed`/`acceptance.failed` event (the log order `readEvents` returns) is `acceptance.passed`. `card.completed` without a judge verdict is NOT acceptance.
   - `tokens`: `lifetimeTokensUsed` from the card's `card.md` frontmatter, wherever the card is on the board (`findCardDir` and `parseCard` from `src/kernel/card.ts`); 0 when the card or the field is missing. (Events carry no token counts today; the loop's `recordSpend` writes this field.)
   - Totals: `cards` = results length; `accepted`, `rounds`, `tokens` = sums; `costPerAccepted = tokens / accepted`, or `null` when `accepted` is 0.
2. In `src/cli.ts`, add a `COMMANDS` entry `name: "cost"`, usage `bandit cost [--json]`, root = `process.cwd()`.
   - `--json`: print `JSON.stringify(report)` on ONE line, as the last line of stdout. Key set exactly as above.
   - Without `--json`: one line per card (id, rounds, tokens, accepted yes/no) and a totals line with cost per accepted card.
   - Exit 0, also on an empty log.

## Acceptance
- On a synthetic log (written with the kernel `appendEvent`): c1 2 rounds, 1000 tokens, passed; c2 3 rounds, 600, failed; c3 1 round, 400, failed then passed; c5 1 round, card folder gone; c6 1 round, 100 tokens, `card.completed` only; c4 on the board but never started. `--json` gives `cards 5, accepted 2, rounds 8, tokens 2100, costPerAccepted 1050` and per-card values to match; c4 is absent.
- Nothing accepted: `costPerAccepted` is `null`; the JSON is exactly `{cards, accepted, rounds, tokens, costPerAccepted, results}`.
- Empty log: `{"cards":0,"accepted":0,"rounds":0,"tokens":0,"costPerAccepted":null,"results":[]}`.
- Text output names every reported card and exits 0.
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
Bandit's score is cost per judge-accepted card (docs/plans/seed.md, Score); this report is how it is read.
The change is outside the kernel: new `src/cost.ts`, `src/cli.ts`. Kernel modules are imported, never edited.
Do not edit tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
