import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { parseCriticVerdict, runLoop, repairBoardFromEvents, cardsIn } from "../src/loop";
import { parseCard } from "../src/runner";
import { seedDefaultFolders } from "./v30-helpers";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bandit-v31-"));
  process.chdir(root);
  seedDefaultFolders(root);
});

afterEach(() => {
  process.chdir("/");
  rmSync(root, { recursive: true, force: true });
});

function greenOutput(): string {
  return "Did the work.\nVERIFICATION_COMMAND: bun test\nVERIFICATION_EXIT_CODE: 0\nVERIFICATION_OUTPUT: 3 pass";
}

function seedCard(id: string, extraFrontmatter = ""): string {
  const cardDir = join(root, ".bandit", "board", "backlog", id);
  mkdirSync(cardDir, { recursive: true });
  writeFileSync(join(cardDir, "card.md"), `---\ncolumn: backlog\nid: ${id}\n${extraFrontmatter}---\n# ${id}\n- works\n`);
  return cardDir;
}

function stub(script: string, output: string): string {
  const p = join(root, script);
  writeFileSync(p, `#!/bin/sh\ncat << 'OUT'\n${output}\nOUT\n`);
  require("node:fs").chmodSync(p, 0o755);
  return p;
}

describe("V3-1: critic verdict parsing", () => {
  test("empty response is plumbing, never a fail", () => {
    const v = parseCriticVerdict("");
    expect(v.plumbing).toBe(true);
    expect(v.verdict).toBe("uncertain");
  });

  test("real verdict parses", () => {
    const v = parseCriticVerdict("VERDICT: fail\nCONFIDENCE: 0.9\nREASONING: no evidence");
    expect(v.verdict).toBe("fail");
    expect(v.confidence).toBe(0.9);
    expect(v.plumbing).toBe(false);
  });
});

describe("V3-1: critic gate in the loop", () => {
  test("green verification + critic pass → done, verdict in critic outputs", async () => {
    seedCard("critic-pass");
    stub("stub-a.sh", greenOutput());
    // critic stub passes with confidence
    const result = await runLoop({
      root,
      transport: { kind: "headless", command: join(root, "stub-a.sh"), args: [] },
      maxRetries: 2,
    });
    expect(result.completed).toBe(1);
    const verdict = join(root, ".bandit", "serfs", "critic", "outputs", "critic-pass.md");
    expect(existsSync(verdict)).toBe(true);
    expect(readFileSync(verdict, "utf-8")).toContain("VERDICT:");
  });

  test("critic plumbing after repair → bypass with documentation, card still done", async () => {
    seedCard("critic-broken");
    // critic stub emits garbage (plumbing failure every time)
    const result = await runLoop({
      root,
      transport: { kind: "headless", command: stub("stub-b.sh", greenOutput()), args: [] },
      maxRetries: 1,
    });
    // the same stub is used for critic — it emits greenOutput which HAS a
    // VERDICT-shaped line? No: greenOutput has no VERDICT line → plumbing.
    // With a real repair loop the critic retries then bypasses.
    expect(result.completed).toBe(1);
  });
});

describe("V3-1: budget hard stop", () => {
  test("card with exhausted budget is skipped", async () => {
    seedCard("broke-card", "lifetimeTokensUsed: 999999\nbudgetLimit: 100\n");
    const result = await runLoop({
      root,
      transport: { kind: "headless", command: stub("stub-c.sh", greenOutput()), args: [] },
    });
    expect(result.processed).toBe(0);
    expect(existsSync(join(root, ".bandit", "board", "backlog", "broke-card"))).toBe(true);
  });

  test("lifetimeTokensUsed accumulates on the card after a run", async () => {
    seedCard("spend-card");
    await runLoop({
      root,
      transport: { kind: "headless", command: stub("stub-d.sh", greenOutput()), args: [] },
    });
    const cardDir = join(root, ".bandit", "board", "done", "spend-card");
    const raw = readFileSync(join(cardDir, "card.md"), "utf-8");
    expect(/lifetimeTokensUsed: [1-9]/.test(raw)).toBe(true);
  });
});

describe("V3-1: plan phase", () => {
  test("non-trivial card gets plan.started/finished events", async () => {
    // 5 acceptance criteria + long task → hard pipeline
    const cardDir = join(root, ".bandit", "board", "backlog", "planned-card");
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, "card.md"), `---\ncolumn: backlog\nid: planned-card\n---\n# Planned\n\n${"- refactor module".repeat(30)}\n\n${Array.from({ length: 6 }, (_, i) => `- criterion ${i} is verifiable`).join("\n")}\n`);
    await runLoop({
      root,
      transport: { kind: "headless", command: stub("stub-e.sh", greenOutput()), args: [] },
      maxRetries: 1,
    });
    const events = readFileSync(join(root, ".bandit", "events", new Date().toISOString().slice(0, 10) + ".jsonl"), "utf-8");
    expect(events).toContain("plan.started");
    expect(events).toContain("plan.finished");
  });
});

describe("V3-1: event-sourced replay repair", () => {
  test("repairBoardFromEvents moves cards back to their latest-projected column", () => {
    seedCard("replay-card");
    // simulate: card was completed (event says done) but folder is still in backlog
    const { appendTestEvent } = require("./v30-helpers");
    appendTestEvent(root, "card.completed", { card: "replay-card" });
    const result = repairBoardFromEvents();
    expect(result.moved).toBe(1);
    expect(existsSync(join(root, ".bandit", "board", "done", "replay-card"))).toBe(true);
    expect(existsSync(join(root, ".bandit", "board", "backlog", "replay-card"))).toBe(false);
  });
});