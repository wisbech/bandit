---
id: failure-draft
title: A failure writes an unratified draft card
verify: bun test ./tests/seed/failure-draft.check.ts
---
# A failure writes an unratified draft card

## Task
In `src/loop.ts`, `runLoop` moves a failed card to review in two places and logs `task.failed` each time: the judge-failure branch (`emit("task.failed", { card: card.id, reason: "judge", ... })`) and the no-convergence branch (`emit("task.failed", { card: card.id, reason: "no-convergence", ... })`). Right after each of those `emit` calls, call a new exported function `writeFailureDraft(root: string, cardId: string): string` (also in `src/loop.ts`) that returns the path it wrote.

`writeFailureDraft` writes `<root>/.bandit/drafts/<cardId>-retry/card.md` (create folders; overwrite an existing draft):
- frontmatter, one `key: value` per line: `id: <cardId>-retry`, `title: <non-empty one-line title, e.g. "retry <cardId>: a smaller step">`. No `verify:` line: the draft is unratified; a human writes and ratifies its check.
- body:
  - the failed card's id;
  - `Last gate: <command>`: the `command` field of the latest `verification.red` event for the card (read with the kernel `readEvents(root)`), else the failed card's `verify:` frontmatter, else `(none)`;
  - the gate output: the LAST 2000 characters of `<failed card dir>/verification-output.log` (find the card dir with `findCardDir(root, cardId)`; the folder is in review by now), inside a fenced code block; empty when the file is missing;
  - a `## Task` section whose first non-blank line proposes a smaller next step for the failed card.
- the whole `card.md` stays under 6000 characters.

Then log `appendEvent(root, "card.drafted", { card: cardId, draft: "<cardId>-retry", path })`.

`.bandit/drafts/` is not a board column: do not add it to the kernel's `COLUMNS` and do not move drafts onto the board. A card that converges writes no draft.

## Acceptance
- A card whose `verify: sh gate.sh` prints 30 KB ending in `GATE-TAIL-MARKER` and exits 1 ends in review, and `.bandit/drafts/<id>-retry/card.md` exists.
- The draft's frontmatter `id` is `<id>-retry` with a non-empty `title`; the body names the failed card; the file contains `sh gate.sh` and `GATE-TAIL-MARKER` but not the first line of the output; it is under 6000 characters; it has a `## Task` section with text.
- Exactly one `card.drafted` event with `card: <id>` and `draft: "<id>-retry"`.
- A second `runLoop` pass processes nothing, the draft is on no board column, and no event other than `card.drafted` names `<id>-retry`.
- A converged card writes no draft and logs no `card.drafted`.
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
Rule 5: a failure writes the next card; a human ratifies each new check. Drafts sit outside the board so nothing runs them until a human promotes and ratifies one.
The change is outside the kernel: `src/loop.ts` only (it imports kernel functions, it does not change them).
Do not edit tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
