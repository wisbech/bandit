// Seed check: cost-report. Human-owned; a candidate that edits this file is rejected by the judge.
// Run: bun test ./tests/seed/cost-report.check.ts
//
// `bandit cost [--json]` reads the event log and the board, per card:
//   rounds   = number of round.started events for the card
//   tokens   = lifetimeTokensUsed from the card's card.md frontmatter in whatever column it is (0 if gone)
//   accepted = the card's LATEST acceptance.passed / acceptance.failed event is acceptance.passed
//              (the judge's verdict; card.completed alone is not acceptance)
// Cards reported: every id that appears in a round.started or acceptance.* event.
// Totals: cards, accepted, rounds, tokens, costPerAccepted = tokens / accepted (null when none).
// --json prints {cards, accepted, rounds, tokens, costPerAccepted, results: [{id, accepted, rounds, tokens}]}
// as one line, the last line of stdout. Exit 0.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent } from "../../src/kernel/log";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "seed-cost-")));
  for (const c of ["backlog", "in-progress", "review", "done"]) mkdirSync(join(root, ".bandit", "board", c), { recursive: true });
  mkdirSync(join(root, ".bandit", "events"), { recursive: true });
  writeFileSync(join(root, ".bandit", "config.json"), JSON.stringify({ transport: "headless", command: "true", args: [] }));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function card(column: string, id: string, tokens?: number): void {
  const d = join(root, ".bandit", "board", column, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "card.md"), `---\n${tokens !== undefined ? `lifetimeTokensUsed: ${tokens}\n` : ""}id: ${id}\ntitle: ${id}\n---\n# ${id}\n`);
}
const rounds = (id: string, n: number) => { for (let r = 1; r <= n; r++) appendEvent(root, "round.started", { card: id, round: r, lever: null }); };

function cost(...args: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["bun", CLI, "cost", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}
function lastJson(stdout: string): any {
  const lines = stdout.trim().split("\n").filter((l) => l.trim());
  return JSON.parse(lines[lines.length - 1]);
}

describe("seed cost-report: bandit cost", () => {
  test("--json: per-card rounds, tokens, accepted, and cost per accepted card", () => {
    card("done", "c1", 1000); rounds("c1", 2);
    appendEvent(root, "acceptance.passed", { card: "c1", ref: "bandit/c1", sha: "a", base: "b", ratified: true, gates: [] });
    appendEvent(root, "card.completed", { card: "c1", verdict: "a" });

    card("review", "c2", 600); rounds("c2", 3);
    appendEvent(root, "acceptance.failed", { card: "c2", ref: "bandit/c2", sha: "c", base: "b", ratified: true, gates: [] });

    card("done", "c3", 400); rounds("c3", 1);
    appendEvent(root, "acceptance.failed", { card: "c3", ref: "bandit/c3", sha: "d", base: "b", ratified: false, gates: [] });
    appendEvent(root, "acceptance.passed", { card: "c3", ref: "bandit/c3", sha: "e", base: "b", ratified: false, gates: [] });

    rounds("c5", 1); // its folder is gone: tokens 0

    card("done", "c6", 100); rounds("c6", 1);
    appendEvent(root, "card.completed", { card: "c6" }); // shared mode: done, never judged

    card("backlog", "c4", 50); // never started: not reported
    appendEvent(root, "card.created", { card: "c4", title: "c4" });

    const r = cost("--json");
    expect(r.code).toBe(0);
    const j = lastJson(r.stdout);
    expect({ cards: j.cards, accepted: j.accepted, rounds: j.rounds, tokens: j.tokens, costPerAccepted: j.costPerAccepted })
      .toEqual({ cards: 5, accepted: 2, rounds: 8, tokens: 2100, costPerAccepted: 1050 });
    const byId = Object.fromEntries((j.results as any[]).map((x) => [x.id, { accepted: x.accepted, rounds: x.rounds, tokens: x.tokens }]));
    expect(byId).toEqual({
      c1: { accepted: true, rounds: 2, tokens: 1000 },
      c2: { accepted: false, rounds: 3, tokens: 600 },
      c3: { accepted: true, rounds: 1, tokens: 400 },
      c5: { accepted: false, rounds: 1, tokens: 0 },
      c6: { accepted: false, rounds: 1, tokens: 100 },
    });
  });

  test("--json with nothing accepted: costPerAccepted is null", () => {
    card("review", "x", 300); rounds("x", 2);
    const j = lastJson(cost("--json").stdout);
    expect(j).toEqual({ cards: 1, accepted: 0, rounds: 2, tokens: 300, costPerAccepted: null, results: [{ id: "x", accepted: false, rounds: 2, tokens: 300 }] });
  });

  test("--json on an empty log", () => {
    const r = cost("--json");
    expect(r.code).toBe(0);
    expect(lastJson(r.stdout)).toEqual({ cards: 0, accepted: 0, rounds: 0, tokens: 0, costPerAccepted: null, results: [] });
  });

  test("text output names every reported card and exits 0", () => {
    card("done", "alpha", 10); rounds("alpha", 1);
    appendEvent(root, "acceptance.passed", { card: "alpha", ref: "r", sha: "s", base: "b", ratified: true, gates: [] });
    card("review", "beta", 20); rounds("beta", 2);
    const r = cost();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("alpha");
    expect(r.stdout).toContain("beta");
  });
});
