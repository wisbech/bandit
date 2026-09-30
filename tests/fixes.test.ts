import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { runLoop } from "../src/loop";
import { seedDefaultFolders } from "./v30-helpers";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Freeze fixes: one regression test per fix.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bandit-fixes-"));
  process.chdir(root);
  seedDefaultFolders(root);
});

afterEach(() => {
  process.chdir("/");
  rmSync(root, { recursive: true, force: true });
});

function seedCard(id: string, body = "# card\n- works\n"): string {
  const cardDir = join(root, ".bandit", "board", "backlog", id);
  mkdirSync(cardDir, { recursive: true });
  writeFileSync(join(cardDir, "card.md"), `---\ncolumn: backlog\nid: ${id}\ntitle: ${id}\n---\n# ${id}\n${body}`);
  return cardDir;
}

function writeStub(name: string, body: string): string {
  const p = join(root, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

describe("fix 1: plan phase runs once", () => {
  test("a standard card gets exactly one plan-only actor render", async () => {
    // 4 acceptance lines → pipelineFor returns "standard"
    seedCard("plan-once", "# card\n- one\n- two\n- three\n- four\n");
    // Actor template marks the plan-only render: {{planOnly}} resolves only when planOnly is set.
    writeFileSync(join(root, ".bandit", "serfs", "actor", "prompt.md"), "You are actor.\n\nTASK: {{card.task}}\nPLAN_ONLY={{planOnly}}\n\nReport VERIFICATION_COMMAND, VERIFICATION_EXIT_CODE, VERIFICATION_OUTPUT.");
    const log = join(root, "prompts.log");
    const transport = writeStub("stub-rec.sh", [
      "#!/bin/sh",
      `printf '%s\\n@@PROMPT_END@@\\n' "$1" >> "${log}"`,
      'echo "work done\\nVERIFICATION_COMMAND: true\\nVERIFICATION_EXIT_CODE: 0\\nVERIFICATION_OUTPUT: ok"',
    ].join("\n"));
    await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 1 });
    const prompts = readFileSync(log, "utf-8").split("@@PROMPT_END@@").filter((p) => p.trim().length > 0);
    expect(prompts.filter((p) => p.includes("PLAN_ONLY=true")).length).toBe(1);
  });
});
