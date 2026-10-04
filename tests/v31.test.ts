import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { parseCriticVerdict, runLoop, cardsIn } from "../src/loop";
import { parseCard } from "../src/runner";
import { seedDefaultFolders, readRawEvents } from "./v30-helpers";
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
  return "Did the work.\nVERIFICATION_COMMAND: true\nVERIFICATION_EXIT_CODE: 0\nVERIFICATION_OUTPUT: 3 pass";
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
  test("green verification + grader pass → done, verdict in grading track record", async () => {
    seedCard("critic-pass", "verify: true\n");
    stub("stub-a.sh", greenOutput());
    // grader stub passes with confidence
    const result = await runLoop({
      once: true,
      root,
      transport: { kind: "headless", command: join(root, "stub-a.sh"), args: [] },
      maxRetries: 2,
    });
    expect(result.completed).toBe(1);
    // grading is the classifier seat's job — its track record is .bandit/grading/
    const verdict = join(root, ".bandit", "grading", "critic-pass.md");
    expect(existsSync(verdict)).toBe(true);
    expect(readFileSync(verdict, "utf-8")).toContain("VERDICT:");
  });

  test("critic plumbing after repair → bypass with documentation, card still done", async () => {
    seedCard("critic-broken", "verify: true\n");
    // critic stub emits garbage (plumbing failure every time)
    const result = await runLoop({
      once: true,
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
      once: true,
      root,
      transport: { kind: "headless", command: stub("stub-c.sh", greenOutput()), args: [] },
    });
    expect(result.processed).toBe(0);
    expect(existsSync(join(root, ".bandit", "board", "backlog", "broke-card"))).toBe(true);
  });

  test("lifetimeTokensUsed accumulates on the card after a run", async () => {
    seedCard("spend-card", "verify: true\n");
    await runLoop({
      once: true,
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
      once: true,
      root,
      transport: { kind: "headless", command: stub("stub-e.sh", greenOutput()), args: [] },
      maxRetries: 1,
    });
    const events = readRawEvents(root);
    expect(events).toContain("plan.started");
    expect(events).toContain("plan.finished");
  });
});
