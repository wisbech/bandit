import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { runLoop, readEvents, cardsIn } from "../src/loop";
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

describe("fix 2: wake reentrancy guard", () => {
  test("persistent mode processes each new card exactly once, including one that arrives mid-pass", async () => {
    writeFileSync(join(root, ".bandit", "serfs", "actor", "prompt.md"), "ACTOR_MARK\nTASK: {{card.task}}\n\nReport VERIFICATION_COMMAND, VERIFICATION_EXIT_CODE, VERIFICATION_OUTPUT.");
    const log = join(root, "prompts.log");
    const transport = writeStub("stub-slow.sh", [
      "#!/bin/sh",
      `printf '%s\\n@@PROMPT_END@@\\n' "$1" >> "${log}"`,
      "sleep 0.3",
      'echo "work done\\nVERIFICATION_COMMAND: true\\nVERIFICATION_EXIT_CODE: 0\\nVERIFICATION_OUTPUT: ok"',
    ].join("\n"));
    const cfg: Parameters<typeof runLoop>[0] = { root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 1 };
    void runLoop(cfg); // persistent: never resolves
    await Bun.sleep(300);
    seedCard("wake-a");
    await Bun.sleep(10);
    seedCard("wake-b");
    await Bun.sleep(1000); // the first wake pass is mid-card now
    seedCard("wake-c");
    const done = () => readEvents().filter((e) => e.type === "card.completed").length >= 3 && cardsIn("in-progress").length === 0;
    for (let t = 0; t < 150 && !done(); t++) await Bun.sleep(100);
    await Bun.sleep(1500); // grace window: a duplicate pass would show up here
    cfg.readOnly = true; // neuter the orphaned watcher before afterEach deletes the board
    const prompts = readFileSync(log, "utf-8").split("@@PROMPT_END@@").filter((p) => p.includes("ACTOR_MARK"));
    const completedEv = readEvents().filter((e) => e.type === "card.completed");
    for (const id of ["wake-a", "wake-b", "wake-c"]) {
      expect({ id, actor: prompts.filter((p) => p.includes(id)).length }).toEqual({ id, actor: 1 });
      expect({ id, completed: completedEv.filter((e) => e.card === id).length }).toEqual({ id, completed: 1 });
    }
    expect(cardsIn("in-progress").length).toBe(0);
  }, 25_000);
});

describe("fix 3: triage does not overwrite the grading record", () => {
  test("grading/<card>.md holds the grade, not the triage reply", async () => {
    seedCard("triage-keep");
    const transport = writeStub("stub-triage.sh", [
      "#!/bin/sh",
      'case "$1" in',
      '  *"TRIAGE:"*) echo "VERDICT: fail\\nCONFIDENCE: 0.9\\nREASONING: TRIAGE-MARKER missing: widget" ;;',
      '  *) echo "work attempted\\nVERIFICATION_COMMAND: false\\nVERIFICATION_EXIT_CODE: 1\\nVERIFICATION_OUTPUT: nope\\nVERDICT: fail\\nCONFIDENCE: 0.9\\nREASONING: GRADE-MARKER" ;;',
      "esac",
    ].join("\n"));
    await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 1 });
    const grade = readFileSync(join(root, ".bandit", "grading", "triage-keep.md"), "utf-8");
    expect(grade).toContain("GRADE-MARKER");
    expect(grade).not.toContain("TRIAGE-MARKER");
  });
});
