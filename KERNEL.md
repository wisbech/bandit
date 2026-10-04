# KERNEL

The part of bandit the judged cannot edit. Human-owned.

## The five rules

1. Nothing counts until the judge says so.
2. The judged cannot edit the judge, the log, or a card's check.
3. Every change is a card, every card has a check, every outcome is logged, including changes to the mechanism itself.
4. Keep what raises the score, revert what lowers it.
5. A failure writes the next card. A human ratifies each new check.

## Kernel paths

- `src/kernel/log.ts`: the event log. One hash-chained segment per writer process per day; `bandit log verify`.
- `src/kernel/card.ts`: a card is a folder; the folder is its column. Claims by rename, fenced moves.
- `src/kernel/judge.ts`: the verdict, `bandit ratify`, `bandit.json`, the protected paths.
- `src/kernel/score.ts`: the project's outside measure; `bandit score` logs `score.read`.
- `KERNEL.md`, `CODEOWNERS`, `checks/`, `bandit.json`.

**Import rule.** Kernel files import only node builtins (`node:*`) and each other. Never `decisions`,
`evaluator-systemone`, `gauge`, `loop`, `refiner` or anything else in `src/`. Enforced by
`tests/kernel-imports.test.ts`. No model calls inside the kernel.

## What human-owned means in practice

- **The judge's protected paths.** A candidate whose diff against the base touches `checks/`, `src/kernel/`,
  `KERNEL.md`, `CODEOWNERS`, `bandit.json`, `package.json`, `bunfig.toml`, a lockfile, a ratified check path
  or a path in `bandit.json`'s `protected` fails with gate `protected-paths`. There is no override flag.
- **The base is the truth.** The judge reads `bandit.json` and `checks/<card>.json` from the base ref
  (default `main`), never from the candidate or the live card, and restores every ratified check file from
  the base, failing when its sha256 differs from the ratified one.
- **Ratification is a commit.** `bandit ratify <card> --paths ...` writes `checks/<card>.json`; a human
  commits it on the base branch. The `card.ratified` event is a record only.
- **CODEOWNERS** names the owner of every kernel path; protect the base branch on the remote.
- **The loop never merges a kernel diff.** A kernel change is made and merged by a human, without the loop.

## Known limits (not built)

- A deleted whole segment is undetectable until log heads are anchored in kept merge commits (Stage 1 card).
- Every short CLI call creates a one-event segment; compaction is not built.
- The judge and the worker run as the same OS user, so the real boundary is git on a protected remote, not
  the filesystem: a worker can edit `.bandit/`, its own segment, or a local `main`. The judge's guarantees
  hold for a base ref the worker cannot push to.
- A claim is a rename plus a log line, checked again before every exit from in-progress; a process that
  stalls between that check and its rename can still move a card a reclaimer has just re-claimed.
- Shared mode has no committed sha, so the loop cannot judge it (`judge.skipped`); only isolation mode is judged.
