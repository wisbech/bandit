// verify.ts — the card-owned verification command: validated at creation,
// split into argv at run time. No shell ever sees it.

const SHELL_OPERATORS = /[;&|`$()<>\n]/;

// null = ok; otherwise the error to show the operator.
export function validateVerifyCommand(cmd: string): string | null {
  if (!cmd.trim()) return "--verify needs a command";
  if (SHELL_OPERATORS.test(cmd)) return "one plain command, no shell operators — wrap complex checks in a script and verify the script";
  return null;
}

// splitArgv lives in kernel/card.ts; re-exported for existing callers.
export { splitArgv } from "./kernel/card";
