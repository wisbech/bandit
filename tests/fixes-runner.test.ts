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

test("fix(6): actor runs from the project root, not the card folder", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { runSerfOnCard } = await import("../src/runner");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bandit-fix6-")));
  const cardDir = join(root, ".bandit", "board", "backlog", "c1");
  const serfDir = join(root, ".bandit", "serfs", "actor");
  mkdirSync(cardDir, { recursive: true });
  mkdirSync(serfDir, { recursive: true });
  writeFileSync(join(cardDir, "card.md"), "---\ntask: t\nverify: true\n---\n");
  writeFileSync(join(serfDir, "prompt.md"), "dir={{card.dir}}");
  writeFileSync(join(serfDir, "serf.md"), "actor");
  const rec = join(root, "pwd.txt");
  const stub = join(root, "stub.sh");
  writeFileSync(stub, `#!/bin/sh\npwd -P > "${rec}"\necho "$1" >> "${rec}"\necho "VERIFICATION_COMMAND: true"\necho "VERIFICATION_EXIT_CODE: 0"\n`);
  chmodSync(stub, 0o755);
  const r = await runSerfOnCard({ serfDir, cardDir, root, transport: { kind: "headless", command: stub, args: [] }, vars: {} });
  const [pwd, prompt] = readFileSync(rec, "utf8").trim().split("\n");
  expect(pwd).toBe(root);
  expect(prompt).toBe(`dir=${cardDir}`);
  expect(r.gate.green).toBe(true);
  expect(existsSync(join(cardDir, "verification-output.log"))).toBe(true);
});
