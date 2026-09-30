import { test, expect } from "bun:test";
import { eventsToText } from "../src/runner";

test("fix(5): eventsToText returns real token sum from step_finish events", () => {
  const fixture = [
    JSON.stringify({ type: "step_start" }),
    JSON.stringify({ type: "text", part: { text: "hello from agent" } }),
    JSON.stringify({ type: "step_finish", tokens: { input: 100, output: 20, reasoning: 5 } }),
    JSON.stringify({ type: "step_finish", tokens: { input: 50, output: 10 } }),
  ].join("\n");
  const r = eventsToText(fixture);
  expect(r.tokens).toBe(185);
  expect(r.text).toContain("hello from agent");
  expect(r.text).toContain("[tokens:");
});
