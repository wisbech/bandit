// verify.ts — the card-owned verification command: validated at creation,
// split into argv at run time. No shell ever sees it.

const SHELL_OPERATORS = /[;&|`$()<>\n]/;

// null = ok; otherwise the error to show the operator.
export function validateVerifyCommand(cmd: string): string | null {
  if (!cmd.trim()) return "--verify needs a command";
  if (SHELL_OPERATORS.test(cmd)) return "one plain command, no shell operators — wrap complex checks in a script and verify the script";
  return null;
}

// Whitespace split that honours double and single quotes (no escapes, no
// expansion — quotes only group words).
export function splitArgv(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let word = false;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word = true;
    } else if (/\s/.test(ch)) {
      if (word) out.push(cur);
      cur = "";
      word = false;
    } else {
      cur += ch;
      word = true;
    }
  }
  if (word) out.push(cur);
  return out;
}
