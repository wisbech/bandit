---
id: refiner-proposals
title: Refiner writes proposal cards and applies nothing
verify: bun test ./tests/seed/refiner-proposals.check.ts
---
# Refiner writes proposal cards and applies nothing

## Task
In `src/refiner.ts`, `export async function runRefinePass(root, refineFn, options)` applies each edit the model returns with `applyEdit(root, edit)`. Add a propose mode.

1. Read `<root>/.bandit/config.json` (missing or invalid JSON means default mode). Propose mode is on when its `"refiner"` field is exactly `"propose"`.
2. In the loop over `edits.slice(0, 8)`, keep the two existing filters (unknown serf goes to `skipped`; evidence shorter than 4 characters goes to `skipped`). For every edit that passes them, in propose mode do NOT call `applyEdit`. Instead write a proposal card:
   - folder `<root>/.bandit/board/backlog/<id>/` with `card.md`; `<id>` starts with `proposal-` and is unique even for two passes in the same millisecond (for example `proposal-<serf>-<target>-<Date.now().toString(36)>-<index>-<4 random chars>`);
   - `card.md` frontmatter, one `key: value` per line (the kernel's `parseCard` reads only single-line values): `id: <id>`, `title: <non-empty one-line title>`, `serf: <edit.serf>`, `target: <edit.target>`, `op: <edit.op>`, and `name: <edit.name>` when set;
   - body: `## Content` followed by `edit.content`, `## Evidence` followed by `edit.evidence`, `## Reason` followed by `edit.reason`;
   - one event per proposal through the existing `emitSafe(root, "refiner.proposed", { card: id, serf, target, op })`.
3. Add `proposed: string[]` to `export interface RefineResult` and return the proposal ids from `runRefinePass` (`[]` in default mode and on early returns). In propose mode `applied` is `[]`.
4. Default mode (no `"refiner"` setting): behaviour unchanged, no proposal cards, no `refiner.proposed` events.

The snapshot and the `history.jsonl` entry are written in both modes as today. Do not write a `verify:` line in proposal cards.

## Acceptance
- With `{"refiner":"propose"}`, a forced pass whose model returns 2 valid edits, 1 for an unknown serf and 1 with evidence `"x"` leaves every file under `.bandit/serfs/` byte-identical.
- Exactly 2 `proposal-*` folders appear in backlog, `result.proposed` lists their ids, `result.applied` is `[]`.
- Each proposal's `parseCard` frontmatter has `id` equal to its folder name, a non-empty `title`, and the edit's `serf`, `target`, `op`; its body contains the edit's content and evidence; the invalid edits leave no proposal.
- Two `refiner.proposed` events whose `card` fields are the proposal ids.
- Two passes in propose mode give 4 distinct proposal cards.
- Without the setting, both valid edits are applied (lesson and prompt note written) and no proposal appears.
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
Rule 3: every change is a card, including changes to the mechanism. The refiner stops editing serf folders directly and proposes; a human ratifies a check before a proposal is ever worked (pausing proposal claims is a separate kernel card).
The change is outside the kernel: `src/refiner.ts` only.
Do not edit tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
