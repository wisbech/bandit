import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eventsToText, agentProfilePath } from "../src/runner";

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

test("fix(4): agent profile resolves from project root in both pane and headless paths", () => {
  expect(agentProfilePath("/p", "critic")).toBe("/p/.opencode/agents/critic.md");
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");
  expect(cli).not.toContain('".bandit", ".opencode"');
  expect(cli).not.toContain('banditDir(), ".opencode"');
});
