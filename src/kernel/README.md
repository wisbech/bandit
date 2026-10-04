# src/kernel

The part of bandit the judged cannot edit. The rules, the path list and the known limits are in
`KERNEL.md` at the repo root. Four files:

- `log.ts`: the event log. One hash-chained segment per writer process per day, `verifyLog`, `logHeads`.
- `card.ts`: a card is a folder on the board; the folder is its column. Parse, find, list, split `verify:`
  into argv; claim by rename (`claimCard`), fenced moves (`moveCard(root, id, from, to)`), reclaim from
  dead claimants.
- `judge.ts`: the verdict. Runs setup, the card's check and the project gates on a ref in a throwaway
  worktree; reads `bandit.json` and `checks/<card>.json` from the base, never the candidate; fails a
  diff that touches a protected path. `ratify` writes a check file for a human to commit.
- `score.ts`: the project's own outside measure (`score` in `bandit.json`), logged as `score.read`.

Deterministic: no model calls inside the kernel. A caller that wants a model's opinion beside a
verdict (the decision-port shadow in `src/accept.ts`) passes `annotate`; it is logged and never votes.

**Import rule.** Kernel files import only node builtins (`node:*`) and each other (`./log`, `./card`,
`./judge`, `./score`). Never `decisions`, `evaluator-systemone`, `gauge`, `loop`, `refiner` or anything
else in `src/`. `tests/kernel-imports.test.ts` enforces it.

**Human-owned.** Rule 2 of the seed plan: the judged cannot edit the judge, the log, or a card's check.
Changes to this directory are made and merged by a human, never by the loop. Old import paths
(`src/loop.ts`, `src/runner.ts`, `src/verify.ts`, `src/accept.ts`) re-export or shim what moved here.
