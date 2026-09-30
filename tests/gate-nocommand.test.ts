import { test, expect } from "bun:test";
import { parseGate } from "../src/runner";

// A claimed exit code with no command is not a green gate. Before this fix
// `command !== undefined` was always true (command defaults to ""), so an
// actor could report VERIFICATION_EXIT_CODE: 0 alone and pass unverified.
test("gate: exit code 0 with no VERIFICATION_COMMAND is not green", () => {
  const gate = parseGate("did the work\nVERIFICATION_EXIT_CODE: 0\nVERIFICATION_OUTPUT: ok\n");
  expect(gate.command).toBe("");
  expect(gate.green).toBe(false);
});

test("gate: a command with exit code 0 is still green", () => {
  expect(parseGate("VERIFICATION_COMMAND: true\nVERIFICATION_EXIT_CODE: 0\n").green).toBe(true);
});
