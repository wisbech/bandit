# Claude Code mod

Before Claude runs Edit, Write, MultiEdit or NotebookEdit, this mod calls `bandit guard --json --repo <cwd> <path>`.
An allowed path goes through unchanged; a protected path, or a guard that cannot run, is refused with a `deny` Claude can
act on (fail closed). Other tools never start a process.

## Load

`claude --plugin-dir adapters/claude-code-mod`

## Configure

Set the `bandit` option of the `bandit-guard` mod to the command that runs bandit, e.g. `bandit` (default) or
`bun /path/to/bandit/src/cli.ts`. It is split on whitespace.
