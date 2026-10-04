# git adapter

`pre-commit` runs `bandit guard` on exactly the staged paths (one argument each, spaces and deletions included) and
blocks the commit on any hit. If the guard cannot run, the commit is blocked too (fail closed).

## Install

Copy it: `cp adapters/git/pre-commit .git/hooks/pre-commit`, or point git at the folder:
`git config core.hooksPath adapters/git`.

## Configure

- `BANDIT`: the command that runs bandit, default `bandit`; may be several words, e.g. `BANDIT="bun /path/to/bandit/src/cli.ts"`.
- `BANDIT_GUARD_ALLOW=1`: the human override. The commit goes through with a warning on stderr.
