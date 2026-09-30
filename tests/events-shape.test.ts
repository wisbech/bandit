import { test, expect } from "bun:test";
import { eventsToText } from "../src/runner";

// Real opencode 1.18 `--format json` shape (captured from a TFD run, 2026-09-30):
// top-level type is step_finish / tool_use / text, and tokens live under `part`.
const real = [
  '{"type":"step_start","timestamp":1,"sessionID":"s","part":{"type":"step-start"}}',
  '{"type":"tool_use","timestamp":2,"sessionID":"s","part":{"type":"tool","tool":"glob","callID":"c1","state":{"status":"completed"}}}',
  '{"type":"text","timestamp":3,"sessionID":"s","part":{"type":"text","text":"VERIFICATION_COMMAND: true"}}',
  '{"type":"step_finish","timestamp":4,"sessionID":"s","part":{"type":"step-finish","reason":"tool-calls","tokens":{"total":12367,"input":12314,"output":53,"reasoning":0}}}',
  '{"type":"step_finish","timestamp":5,"sessionID":"s","part":{"type":"step-finish","reason":"stop","tokens":{"total":100,"input":80,"output":20,"reasoning":0}}}',
].join("\n");

test("eventsToText reads tokens from part.tokens (real opencode shape) and keeps text + tool lines", () => {
  const { text, tokens } = eventsToText(real);
  expect(tokens).toBe(12314 + 53 + 80 + 20);
  expect(text).toContain("[tool: glob]");
  expect(text).toContain("VERIFICATION_COMMAND: true");
  expect(text).toContain("[tokens: in=12394 out=73]");
});
