import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { migrate } from "../src/migrate";
import { cardsIn } from "../src/loop";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bandit-v33-"));
  process.chdir(root);
  // seed a realistic v2 .serf
  mkdirSync(join(root, ".serf", "board", "backlog"), { recursive: true });
  mkdirSync(join(root, ".serf", "board", "done"), { recursive: true });
  mkdirSync(join(root, ".serf", "serfs", "master", "outputs"), { recursive: true });
  mkdirSync(join(root, ".serf", "serfs", "master", "memory"), { recursive: true });
  mkdirSync(join(root, ".serf", "serfs", "critic", "outputs"), { recursive: true });
  mkdirSync(join(root, ".serf", "serfs", "actor", "outputs"), { recursive: true });
  mkdirSync(join(root, ".serf", "events"), { recursive: true });

  writeFileSync(join(root, ".serf", "board", "done", "my-card.md"), "# My Card\n\n## Task\nDo the thing\n");
  writeFileSync(join(root, ".serf", "board", "done", "my-card-output.md"), "<<answer>>done<<answer>>");
  writeFileSync(join(root, ".serf", "board", "done", "my-card-verdict.md"), "VERDICT: pass");
  writeFileSync(join(root, ".serf", "board", "backlog", "other-card.md"), "# Other\n");
  writeFileSync(join(root, ".serf", "serfs", "actor.md"), "# actor\n\n## Mission\nExecute.\n");
  writeFileSync(join(root, ".serf", "STATE.md"), "# Session history\n\n- learned stuff\n");
  writeFileSync(join(root, ".serf", "config.json"), JSON.stringify({ transport: "herdr", verificationContainer: "tradingroom-dev" }));
  writeFileSync(join(root, ".serf", "events", "2026-09-11.jsonl"), '{"type":"card.created","ts":"2026-09-11T00:00:00Z","card":"my-card"}\n');
});

afterEach(() => {
  process.chdir("/");
  rmSync(root, { recursive: true, force: true });
});

describe("V3-3: v2 → v3 migration", () => {
  test("cards become folders with sidecars folded inside", () => {
    const report = migrate(root);
    expect(report.cards).toBe(2);
    expect(report.sidecarsFolded).toBe(2);
    // card folder: card.md + outputs/ (output + verdict folded)
    expect(existsSync(join(root, ".bandit", "board", "done", "my-card", "card.md"))).toBe(true);
    expect(existsSync(join(root, ".bandit", "board", "done", "my-card", "outputs", "my-card-output.md"))).toBe(true);
    expect(existsSync(join(root, ".bandit", "board", "done", "my-card", "outputs", "my-card-verdict.md"))).toBe(true);
    // v2 sidecars removed after fold
    expect(existsSync(join(root, ".serf", "board", "done", "my-card-output.md"))).toBe(false);
  });

  test("flat serf .md folds into a folder; folder serfs pass through", () => {
    const report = migrate(root);
    expect(report.flatSerfsFolded).toBe(1);
    expect(existsSync(join(root, ".bandit", "serfs", "actor", "serf.md"))).toBe(true);
    expect(report.serfsPassed).toBe(3); // master, critic, actor folders
    // v3 subfolders ensured
    expect(existsSync(join(root, ".bandit", "serfs", "master", "journal"))).toBe(true);
  });

  test("STATE.md folds into master/state.md; events copied; config translated", () => {
    const report = migrate(root);
    expect(report.stateFolded).toBe(true);
    expect(readFileSync(join(root, ".bandit", "serfs", "master", "state.md"), "utf-8")).toContain("learned stuff");
    expect(existsSync(join(root, ".bandit", "events", "2026-09-11.jsonl"))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(root, ".bandit", "config.json"), "utf-8"));
    expect(cfg.verificationContainer).toBe("tradingroom-dev");
    expect(cfg.transport).toBe("headless"); // herdr → headless default in v3
    expect(existsSync(join(root, ".serf", ".migrated-to-v3"))).toBe(true);
  });

  test("migration is idempotent", () => {
    migrate(root);
    const second = migrate(root);
    expect(second.cards).toBe(0);
    expect(second.sidecarsFolded).toBe(0);
  });

  test("dry-run changes nothing", () => {
    const report = migrate(root, { dryRun: true });
    expect(report.notes).toContain("dry-run: no changes written");
    expect(existsSync(join(root, ".bandit"))).toBe(false);
    expect(report.cards).toBe(2);
  });

  test("migrated cards read via the v3 board projection", () => {
    migrate(root);
    const done = cardsIn("done");
    expect(done.some((c) => c.id === "my-card")).toBe(true);
    const backlog = cardsIn("backlog");
    expect(backlog.some((c) => c.id === "other-card")).toBe(true);
  });
});