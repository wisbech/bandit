// Seed check: bench. Human-owned; a candidate that edits this file is rejected by the judge.
// Run: bun test ./tests/seed/bench.check.ts
//
// `bandit bench <board-dir> [--json]`: copy a frozen board (a directory of card folders) into a
// fresh temp project under os.tmpdir() (git init, one commit, isolation "worktree" so the judge
// decides), copy the invoking project's serfs and transport config, run the loop once there,
// print {cards, accepted, rounds, tokens, costPerAccepted, results: [{id, accepted, rounds, tokens}]}
// (--json: one line, the last line of stdout), then remove the temp project. accepted = the
// card's latest acceptance.* event in the temp log is acceptance.passed; rounds = round.started
// events; tokens = lifetimeTokensUsed in the card's frontmatter. The invoking project is untouched.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { readEvents } from "../../src/kernel/log";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

let base: string;    // everything this test makes lives under here
let project: string; // the invoking project
let board: string;   // the frozen board
let benchTmp: string; // TMPDIR for the bench process
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "seed-bench-")));
  project = join(base, "project");
  board = join(base, "frozen");
  benchTmp = join(base, "tmp");
  mkdirSync(benchTmp, { recursive: true });
  for (const c of ["backlog", "in-progress", "review", "done"]) mkdirSync(join(project, ".bandit", "board", c), { recursive: true });
  mkdirSync(join(project, ".bandit", "events"), { recursive: true });
  for (const name of ["master", "critic", "actor"]) {
    mkdirSync(join(project, ".bandit", "serfs", name), { recursive: true });
    writeFileSync(join(project, ".bandit", "serfs", name, "serf.md"), `# ${name}\n`);
    writeFileSync(join(project, ".bandit", "serfs", name, "prompt.md"), `You are ${name}.\nTASK: {{card.task}}\n`);
  }
  const stub = join(base, "stub.sh");
  writeFileSync(stub, [
    "#!/bin/sh",
    'if echo "$1" | grep -q "Grade the work"; then echo "VERDICT: pass\\nCONFIDENCE: 0.9\\nREASONING: ok"; exit 0; fi',
    'case "$1" in',
    '  *"CONSULT (routing)"*) echo "DECISION: escalate";;',
    '  *"CONSULT"*) echo "Same wall.\\n\\nDECISION: proceed";;',
    '  *) echo "did the work\\nVERIFICATION_COMMAND: true\\nVERIFICATION_EXIT_CODE: 0\\nVERIFICATION_OUTPUT: ok";;',
    "esac",
  ].join("\n"));
  chmodSync(stub, 0o755);
  writeFileSync(join(project, ".bandit", "config.json"), JSON.stringify({ transport: "headless", command: stub, args: [], maxRetries: 2 }));
  for (const [id, verify] of [["b1-pass", "true"], ["b2-pass", "true"], ["b3-fail", "false"]]) {
    mkdirSync(join(board, id), { recursive: true });
    writeFileSync(join(board, id, "card.md"), `---\nid: ${id}\ntitle: ${id}\nverify: ${verify}\n---\n# ${id}\n- works\n`);
  }
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p) + "\t" + readFileSync(p, "utf-8"));
    }
  };
  walk(dir);
  return out;
}

function bench(...args: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["bun", CLI, "bench", ...args], {
    cwd: project, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, TMPDIR: benchTmp },
  });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

describe("seed bench: a frozen board in a temp project, one JSON line out", () => {
  test("3-card frozen board: two accepted by the judge, one not; totals add up", () => {
    const boardBefore = snapshot(board);
    const projectBefore = readdirSync(project).sort();
    const r = bench(board, "--json");
    if (r.code !== 0) throw new Error(`bench exited ${r.code}\nstdout:\n${r.stdout.slice(-2000)}\nstderr:\n${r.stderr.slice(-2000)}`);
    const lines = r.stdout.trim().split("\n").filter((l) => l.trim());
    const j = JSON.parse(lines[lines.length - 1]);

    expect(j.cards).toBe(3);
    expect(j.accepted).toBe(2);
    const byId = Object.fromEntries((j.results as any[]).map((x) => [x.id, x]));
    expect(Object.keys(byId).sort()).toEqual(["b1-pass", "b2-pass", "b3-fail"]);
    expect(byId["b1-pass"].accepted).toBe(true);
    expect(byId["b2-pass"].accepted).toBe(true);
    expect(byId["b3-fail"].accepted).toBe(false);
    expect(byId["b1-pass"].rounds).toBe(1);
    expect(byId["b2-pass"].rounds).toBe(1);
    expect(byId["b3-fail"].rounds).toBe(2);
    for (const x of j.results as any[]) expect(x.tokens).toBeGreaterThan(0);
    const tokens = (j.results as any[]).reduce((s, x) => s + x.tokens, 0);
    expect(j.tokens).toBe(tokens);
    expect(j.rounds).toBe(4);
    expect(j.costPerAccepted).toBeCloseTo(tokens / 2, 6);

    // the frozen board and the invoking project are untouched; nothing is left in TMPDIR
    expect(snapshot(board)).toEqual(boardBefore);
    expect(readdirSync(project).sort()).toEqual(projectBefore);
    for (const c of ["backlog", "in-progress", "review", "done"]) expect(readdirSync(join(project, ".bandit", "board", c))).toEqual([]);
    expect(readEvents(project).some((e) => e.type === "round.started")).toBe(false);
    const leftovers = readdirSync(benchTmp).filter((n) => existsSync(join(benchTmp, n, ".bandit")) || existsSync(join(benchTmp, n, ".git")));
    expect(leftovers).toEqual([]);
  }, 120_000);

  test("a missing board directory is a usage error (exit 2)", () => {
    const r = bench(join(base, "no-such-board"), "--json");
    expect(r.code).toBe(2);
  }, 30_000);
});
