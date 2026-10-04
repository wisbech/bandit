---
id: measures
title: bandit measures - cost per accepted card and lines per ratified check, and their change
verify: bun test ./tests/seed/measures.check.ts
---
# bandit measures - cost per accepted card and lines per ratified check, and their change

## Task
Add one read of the two numbers progress is judged by: what an accepted card costs, and how much source the
ratified checks have to hold up. Then a comparison of the latest read with the one before it.

1. New file `src/measures.ts` exporting exactly:

```ts
export type Measures = {
  costPerAccepted: number | null; accepted: number; tokens: number;
  sourceLines: number; ratifiedChecks: number; linesPerCheck: number | null;
};
export type Change = { previous: number; current: number; delta: number };
export function readMeasures(root: string, repoDir?: string): Measures; // repoDir defaults to root
export function progressSince(root: string): { costPerAccepted: Change | null; linesPerCheck: Change | null };
```

   `readMeasures(root, repoDir = root)`:
   - `costPerAccepted`, `accepted`, `tokens`: the same fields of `costReport(root)` from `src/cost.ts` (import it; do not change it).
   - `sourceLines`: the total line count of every file whose name ends in `.ts` under `<repoDir>/src`, recursively (`.tsx`, `.js`, `.md` do not count; files outside `src/` do not count; no `src/` folder gives 0). A file's line count is its number of `\n` characters, plus 1 when the file is non-empty and does not end with `\n` (so `"x\ny"` is 2, `"\n\n"` is 2, `""` is 0). Every line counts, blank or comment: this is a crude description-length proxy; say so in a comment.
   - `ratifiedChecks`: the number of files `<repoDir>/checks/*.json` whose card is accepted. The card id is the file name without `.json` (`checks/alpha.json` is card `alpha`; do not read the file). A card is accepted when its LATEST `acceptance.passed` or `acceptance.failed` event in `readEvents(root)` (from `src/kernel/log.ts`, log order) is `acceptance.passed`. `acceptance.started` and every other event type are ignored. Other files in `checks/` (e.g. `notes.txt`) are ignored; no `checks/` folder gives 0.
   - `linesPerCheck`: `sourceLines / ratifiedChecks`, or `null` when `ratifiedChecks` is 0.
   - The returned object has exactly these six keys.

   `progressSince(root)`: take the `measure.read` events from `readEvents(root)`, in log order, and compare the last one (current) with the one before it (previous). For each of `costPerAccepted` and `linesPerCheck`: `{ previous, current, delta: current - previous }`, or `null` when there are fewer than two `measure.read` events or when either of the two values is `null`. Always return both keys.

2. In `src/cli.ts`, add a `COMMANDS` entry `name: "measures"`, usage `bandit measures [--json]`, with `root = repoDir = process.cwd()`:
   - Compute `readMeasures(process.cwd())`.
   - Append exactly one event through the kernel: `appendEvent(root, "measure.read", { costPerAccepted, sourceLines, ratifiedChecks, linesPerCheck })` (`import { appendEvent } from "./kernel/log"`), in both modes.
   - `--json`: print `JSON.stringify(measures)` on ONE line, the last line of stdout; the key set exactly as above.
   - Without `--json`: one line per field, `  <field> <value>` (the six field names verbatim), and you may add a line with `progressSince`.
   - Exit 0, also on an empty log and an empty repo.

## Acceptance
- A board where alpha passed (1000 tokens), beta passed then failed (600), gamma failed then passed then got a new `acceptance.started` (300), delta never judged, omega passed (200) with no checks file, `checks/{alpha,beta,gamma,delta}.json`, and a src tree of 7 `.ts` lines: `readMeasures` is `{costPerAccepted: 700, accepted: 3, tokens: 2100, sourceLines: 7, ratifiedChecks: 2, linesPerCheck: 3.5}`, and the cost fields equal `costReport(root)`.
- `repoDir` given: `src/` and `checks/` come from repoDir, the log and board from root.
- No ratified check: `linesPerCheck` null; no `src/`: 0; empty log: `costPerAccepted` null.
- `bandit measures --json` prints that object on its last line, exits 0, and appends exactly one `measure.read` with the four fields; text mode names all six fields and also appends one event.
- Two reads around deleting a 3-line file: `progressSince(root).linesPerCheck` is `{previous: 3.5, current: 2, delta: -1.5}`.
- `progressSince`: both null with 0 or 1 events; the last two events are compared, other events in between ignored; a null on either side nulls that field only.
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
Compression progress (Schmidhuber): the interesting thing is the first derivative of compressibility. For bandit,
the scaffold is the compressor and progress is the fall in cost per accepted card, and in the source the
ratified checks have to hold up. This card only measures; nothing acts on the numbers yet.
Builds on `costReport` in `src/cost.ts` (do not change its output). The change is outside the kernel: new
`src/measures.ts`, `src/cli.ts`. Kernel modules are imported, never edited.
Do not edit seed/, tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
