---
id: keep-rule
title: Paired sign-test keep rule, a pure function
verify: bun test ./tests/seed/keep-rule.check.ts
---
# Paired sign-test keep rule, a pure function

## Task
Create `src/keep-rule.ts` (no imports needed) exporting:

```ts
export type Pair = { baseline: boolean; candidate: boolean; baselineTokens?: number; candidateTokens?: number };
export type KeepDecision = { decision: "keep" | "revert" | "continue"; wins: number; losses: number; reason: string };
export function keepDecision(pairs: Pair[], total: number = pairs.length): KeepDecision;
```

Each pair is one benchmark card run by the baseline and by the candidate. `total` is how many pairs the benchmark will have in all (default: all pairs are already in).

Rules, in this order:
1. Walk `pairs` in order. A pair is a WIN when `candidate && !baseline`, a LOSS when `baseline && !candidate`; concordant pairs (both true or both false) change nothing.
2. After each pair, if `losses - wins >= 2`: return `revert` immediately with the wins and losses counted so far (early abort; later pairs are not looked at).
3. If `pairs.length < total`: return `continue` with the totals so far.
4. All pairs are in. If `wins - losses >= 5`: `keep`. (Keep is judged only when all pairs are in.)
5. If `wins === losses` (an exact tie, including 0-0): consider only the pairs that carry BOTH `baselineTokens` and `candidateTokens` as numbers. If there is at least one such pair and `candidateTokens < baselineTokens` (strictly) on at least 75% of them (`lower * 4 >= withData * 3`; 9 of 12 is the plan's case): `keep`.
6. Otherwise: `revert` (the default).

`reason` is always a non-empty string saying which rule decided. The function is pure: it does not mutate its input and returns the same result for the same input.

## Acceptance
- 5 wins, all in: keep. Concordant pairs mixed in are ignored.
- W-L = 4 with all pairs in: revert.
- `L, L, W x9`: revert at the 2nd pair with wins 0, losses 2.
- `W, L, L, L, ...`: revert with wins 1, losses 3.
- `[L, BOTH, L]` with total 12: revert, not continue.
- 3 of 12 pairs in, no abort: continue. 5 straight wins of 12: continue (keep waits for all pairs).
- Exact tie with tokens lower on 9 of 12 (or 12 of 12): keep; on 8 of 12: revert; no token data: revert; token data on 4 pairs, lower on 3: keep; equal tokens are not lower.
- No pairs: revert. Not a tie with all tokens lower: revert.
- The input is not mutated; two calls agree.
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
The keep-or-revert rule for self-edits (docs/plans/seed.md, Design decisions): paired sign test, keep at +5, abort at -2, tie broken by tokens, default revert. Pure so Stage 3 can use it from the loop or a script.
The change is outside the kernel: new `src/keep-rule.ts` only.
Do not edit tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
