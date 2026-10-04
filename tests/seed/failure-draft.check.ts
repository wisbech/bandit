// Seed check: failure-draft. Human-owned; a candidate that edits this file is rejected by the judge.
// Run: bun test ./tests/seed/failure-draft.check.ts
//
// When runLoop sends a card to review with task.failed, it writes an unratified draft card to
// .bandit/drafts/<id>-retry/card.md (frontmatter id: <id>-retry, title; body names the failed card,
// the last gate command, the gate output bounded to its last 2000 characters, and a ## Task
// proposing a smaller next step) and logs card.drafted { card: <id>, draft: "<id>-retry", path }.
// .bandit/drafts/ is not a board column: the loop never claims a draft.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLoop } from "../../src/loop";
import { readEvents } from "../../src/kernel/log";
import { parseCard, findCardDir } from "../../src/kernel/card";

let root: string;
let prevCwd: string;
beforeEach(() => {
  prevCwd = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), "seed-draft-")));
  process.chdir(root);
  for (const c of ["backlog", "in-progress", "review", "done"]) mkdirSync(join(root, ".bandit", "board", c), { recursive: true });
  mkdirSync(join(root, ".bandit", "events"), { recursive: true });
  for (const name of ["master", "critic", "actor"]) {
    mkdirSync(join(root, ".bandit", "serfs", name), { recursive: true });
    writeFileSync(join(root, ".bandit", "serfs", name, "serf.md"), `# ${name}\n`);
    writeFileSync(join(root, ".bandit", "serfs", name, "prompt.md"), `You are ${name}.\nTASK: {{card.task}}\n`);
  }
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
});

// The grader passes, routing escalates, the actor claims green; the card's own verify is red.
function stub(): string {
  const p = join(root, "stub.sh");
  writeFileSync(p, [
    "#!/bin/sh",
    'if echo "$1" | grep -q "Grade the work"; then echo "VERDICT: pass\\nCONFIDENCE: 0.9\\nREASONING: ok"; exit 0; fi',
    'case "$1" in',
    '  *"CONSULT (routing)"*) echo "DECISION: escalate";;',
    '  *) echo "attempt\\nVERIFICATION_COMMAND: true\\nVERIFICATION_EXIT_CODE: 0\\nVERIFICATION_OUTPUT: fine";;',
    "esac",
  ].join("\n"));
  chmodSync(p, 0o755);
  return p;
}

// A red gate with 30 KB of output whose tail carries a marker.
function seedFailingCard(id: string): void {
  writeFileSync(join(root, "gate.sh"), "#!/bin/sh\ni=0\nwhile [ $i -lt 600 ]; do echo \"noise line $i ..................................\"; i=$((i+1)); done\necho GATE-TAIL-MARKER\nexit 1\n");
  const d = join(root, ".bandit", "board", "backlog", id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "card.md"), `---\nid: ${id}\ntitle: make the widget\nverify: sh gate.sh\n---\n# make the widget\n\n## Task\nBuild the widget.\n\n## Acceptance\n- gate.sh passes\n`);
}

describe("seed failure-draft: a failure writes the next card, unratified", () => {
  test("a card that ends in review leaves a bounded draft in .bandit/drafts/<id>-retry and logs card.drafted", async () => {
    seedFailingCard("widget");
    const r = await runLoop({ once: true, root, transport: { kind: "headless", command: stub(), args: [] }, maxRetries: 1 });
    expect(r.failed).toBe(1);
    expect(existsSync(join(root, ".bandit", "board", "review", "widget"))).toBe(true);

    const draftDir = join(root, ".bandit", "drafts", "widget-retry");
    const draftMd = join(draftDir, "card.md");
    expect(existsSync(draftMd)).toBe(true);
    const raw = readFileSync(draftMd, "utf-8");
    const draft = parseCard(draftDir);
    expect(draft.frontmatter.id).toBe("widget-retry");
    expect(draft.frontmatter.title ?? "").not.toBe("");
    expect(draft.body).toContain("widget");            // the failed card
    expect(raw).toContain("sh gate.sh");                // the last gate command
    expect(raw).toContain("GATE-TAIL-MARKER");          // the end of the gate output
    expect(raw).not.toContain("noise line 0 ");         // ...bounded: the head of 30 KB is cut
    expect(raw.length).toBeLessThan(6_000);
    expect(draft.body).toMatch(/^## Task[ \t]*\n\s*\S/m); // a proposed next step

    const drafted = readEvents(root).filter((e) => e.type === "card.drafted");
    expect(drafted.length).toBe(1);
    expect(drafted[0].card).toBe("widget");
    expect(drafted[0].draft).toBe("widget-retry");
  }, 60_000);

  test("drafts are never picked up by the loop", async () => {
    seedFailingCard("widget");
    const transport = { kind: "headless" as const, command: stub(), args: [] };
    await runLoop({ once: true, root, transport, maxRetries: 1 });
    const second = await runLoop({ once: true, root, transport, maxRetries: 1 });
    expect(second.processed).toBe(0);
    expect(findCardDir(root, "widget-retry")).toBeNull();
    expect(existsSync(join(root, ".bandit", "drafts", "widget-retry", "card.md"))).toBe(true);
    expect(readEvents(root).some((e) => e.card === "widget-retry" && e.type !== "card.drafted")).toBe(false);
  }, 60_000);

  test("a card that converges writes no draft", async () => {
    const d = join(root, ".bandit", "board", "backlog", "easy");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "card.md"), "---\nid: easy\ntitle: easy\nverify: true\n---\n# easy\n- works\n");
    const r = await runLoop({ once: true, root, transport: { kind: "headless", command: stub(), args: [] }, maxRetries: 1 });
    expect(r.completed).toBe(1);
    expect(existsSync(join(root, ".bandit", "drafts", "easy-retry"))).toBe(false);
    expect(readEvents(root).some((e) => e.type === "card.drafted")).toBe(false);
  }, 60_000);
});
