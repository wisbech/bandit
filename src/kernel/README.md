# src/kernel

The part of bandit the judged cannot edit. Three files today:

- `log.ts`: the event log. One hash-chained segment per writer process per day, `verifyLog`, `logHeads`.
- `card.ts`: a card is a folder on the board. Parse, find, list, move, and split `verify:` into argv.
- `judge.ts`: the verdict. Runs the card's check and the project gates on a ref in a throwaway worktree.

Deterministic: no model calls inside the kernel. A caller that wants a model's opinion beside a
verdict (the decision-port shadow in `src/accept.ts`) passes `annotate`; it is logged and never votes.

**Import rule.** Kernel files import only node builtins (`node:*`) and each other (`./log`, `./card`,
`./judge`). Never `decisions`, `evaluator-systemone`, `gauge`, `loop`, `refiner` or anything else in
`src/`. `tests/kernel-imports.test.ts` enforces it.

**Human-owned.** Rule 2 of the seed plan: the judged cannot edit the judge, the log, or a card's check.
Changes to this directory are made and merged by a human, never by the loop. Old import paths
(`src/loop.ts`, `src/runner.ts`, `src/verify.ts`, `src/accept.ts`) re-export or shim what moved here.
