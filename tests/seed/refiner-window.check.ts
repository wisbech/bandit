// Seed check: refiner-window. Human-owned; a candidate that edits this file is rejected by the judge.
// Run: bun test ./tests/seed/refiner-window.check.ts
//
// shouldTrigger(root) counts only events after the refiner's last pass: the ts of the last
// entry with action "refine" in .bandit/refiner/history.jsonl. No such entry: all events count
// (unchanged). A threshold reached before the last pass does not fire again; new events after it do.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shouldTrigger, runRefinePass } from "../../src/refiner";
import { appendEvent } from "../../src/kernel/log";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "seed-refwin-")));
  mkdirSync(join(root, ".bandit", "events"), { recursive: true });
  for (const name of ["master", "critic", "actor"]) {
    mkdirSync(join(root, ".bandit", "serfs", name, "memory"), { recursive: true });
    writeFileSync(join(root, ".bandit", "serfs", name, "serf.md"), `# ${name}\n`);
    writeFileSync(join(root, ".bandit", "serfs", name, "prompt.md"), `You are ${name}.\n`);
  }
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const tick = () => Bun.sleep(5); // event and history timestamps are milliseconds; keep them apart
const fail = (card: string) => appendEvent(root, "task.failed", { card, reason: "no-convergence" });
const noEdits = async () => "[]";

describe("seed refiner-window: the refiner triggers on events since its last pass", () => {
  test("no history: all-time counts still trigger (unchanged)", () => {
    fail("a"); fail("b"); fail("c");
    expect(shouldTrigger(root).trigger).toBe(true);
  });

  test("failures counted before the last pass do not re-trigger; three new ones do", async () => {
    fail("a"); fail("b"); fail("c");
    await tick();
    const pass = await runRefinePass(root, noEdits);
    expect(pass.ran).toBe(true);
    await tick();
    expect(shouldTrigger(root).trigger).toBe(false);
    fail("d"); fail("e");
    expect(shouldTrigger(root).trigger).toBe(false);
    fail("f");
    const t = shouldTrigger(root);
    expect(t.trigger).toBe(true);
    expect(t.reason).toContain("3");
  });

  test("a non-forced pass right after a pass does not run again", async () => {
    fail("a"); fail("b"); fail("c");
    await tick();
    expect((await runRefinePass(root, noEdits)).ran).toBe(true);
    await tick();
    expect((await runRefinePass(root, noEdits)).ran).toBe(false);
  });

  test("critic plumbing: two before the pass are spent; the window needs two new ones", async () => {
    appendEvent(root, "critic.repair", { card: "a", turn: 0 });
    appendEvent(root, "critic.repair", { card: "a", turn: 1 });
    expect(shouldTrigger(root).trigger).toBe(true);
    await tick();
    expect((await runRefinePass(root, noEdits)).ran).toBe(true);
    await tick();
    appendEvent(root, "critic.repair", { card: "b", turn: 0 });
    expect(shouldTrigger(root).trigger).toBe(false);
    appendEvent(root, "critic.bypass", { card: "b", round: 1 });
    expect(shouldTrigger(root).trigger).toBe(true);
  });

  test("the window starts at the LAST refine entry; a later rollback entry does not move it", async () => {
    const hist = join(root, ".bandit", "refiner", "history.jsonl");
    mkdirSync(join(root, ".bandit", "refiner"), { recursive: true });
    fail("a"); fail("b");
    await tick();
    appendFileSync(hist, JSON.stringify({ ts: new Date().toISOString(), action: "refine", edits: [] }) + "\n");
    await tick();
    fail("c"); fail("d");
    await tick();
    appendFileSync(hist, JSON.stringify({ ts: new Date().toISOString(), action: "refine", edits: [] }) + "\n");
    await tick();
    fail("e"); fail("f");
    await tick();
    appendFileSync(hist, JSON.stringify({ ts: new Date().toISOString(), action: "rollback", to: "x", edits: [] }) + "\n");
    // since the last refine: e, f — two failures, below the threshold of three
    expect(shouldTrigger(root).trigger).toBe(false);
    fail("g");
    expect(shouldTrigger(root).trigger).toBe(true);
  });
});
