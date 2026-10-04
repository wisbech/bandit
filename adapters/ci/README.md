# CI adapter (GitHub Actions)

`github-accept.yml` runs `bandit accept` on a pull request and fails the job when the judge's verdict fails.

## Install

Copy it to `.github/workflows/github-accept.yml`, then put the card on its own line in the PR body:

    bandit-card: <id>

A PR without that line is skipped with a notice.

## Why it is shaped this way

- The PR body and every `${{ }}` value reach scripts through `env`, never interpolated into a `run:` script (script injection).
- `git branch -f main "origin/$BASE_REF"` makes the PR's base the judge's base (the judge reads `bandit.json` and `checks/` from `main`).
  On `pull_request` the checkout is the PR's merge commit (detached), so `main` is not checked out and the force-move works.
- The card folder is copied onto the board because `accept` finds the card there.
