// Seed check: measures. Human-owned; a candidate that edits this file is rejected by the judge.
// Run: bun test ./tests/seed/measures.check.ts   (the ./ matters: *.check.ts is outside bun's default glob)
//
// src/measures.ts exports
//   readMeasures(root, repoDir = root) -> { costPerAccepted, accepted, tokens, sourceLines, ratifiedChecks, linesPerCheck }
//     costPerAccepted, accepted, tokens: exactly costReport(root) from src/cost.ts
//     sourceLines:    every line of every *.ts file under <repoDir>/src, recursively (a crude description-length
//                     proxy): newline characters, plus 1 for a non-empty last line without one; 0 without src/
//     ratifiedChecks: checks/<id>.json files in repoDir whose card <id>'s LATEST acceptance.passed /
//                     acceptance.failed event in root's log is acceptance.passed (acceptance.started is not a verdict)
//     linesPerCheck:  sourceLines / ratifiedChecks, null when ratifiedChecks is 0
//   progressSince(root) -> { costPerAccepted: {previous, current, delta} | null, linesPerCheck: same }
//     from the two most recent measure.read events (log order); a field is null with fewer than two events
//     or when either of its two values is null; delta = current - previous
// `bandit measures [--json]` (root = repoDir = cwd): --json prints the readMeasures object as one JSON line,
// the last line of stdout; without it, one line per field. Either way exit 0 and append exactly one
// measure.read { costPerAccepted, sourceLines, ratifiedChecks, linesPerCheck } event.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, readEvents } from "../../src/kernel/log";

const SRC = join(import.meta.dir, "..", "..", "src");
const MEASURES = join(SRC, "measures.ts");
const CLI = join(SRC, "cli.ts");

async function measures(): Promise<any> {
  expect(existsSync(MEASURES)).toBe(true);
  const mod: any = await import(MEASURES);
  expect(typeof mod.readMeasures).toBe("function");
  expect(typeof mod.progressSince).toBe("function");
  return mod;
}

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

let root: string;
beforeEach(() => {
  root = tmp("seed-measures-");
  for (const c of ["backlog", "in-progress", "review", "done"]) mkdirSync(join(root, ".bandit", "board", c), { recursive: true });
  mkdirSync(join(root, ".bandit", "events"), { recursive: true });
  writeFileSync(join(root, ".bandit", "config.json"), JSON.stringify({ transport: "headless", command: "true", args: [] }));
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(base: string, rel: string, text: string): void {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

function card(column: string, id: string, tokens: number): void {
  write(root, `.bandit/board/${column}/${id}/card.md`, `---\nlifetimeTokensUsed: ${tokens}\nid: ${id}\ntitle: ${id}\n---\n# ${id}\n`);
}
const verdict = (id: string, type: string) => appendEvent(root, type, { card: id, ref: `bandit/${id}`, sha: "s", base: "b", ratified: true, gates: [] });

// A fake source tree: 7 lines of *.ts under src/, plus files that must not count.
function srcTree(base: string): void {
  write(base, "src/a.ts", "one\ntwo\nthree\n");        // 3
  write(base, "src/sub/b.ts", "x\ny");                // 2: the last line has no newline
  write(base, "src/sub/deep/c.ts", "\n\n");           // 2: blank lines count
  write(base, "src/sub/empty.ts", "");                // 0
  write(base, "src/readme.md", "1\n2\n3\n4\n");       // not .ts
  write(base, "src/d.js", "1\n2\n");                  // not .ts
  write(base, "src/e.tsx", "1\n2\n");                 // not .ts
  write(base, "tests/t.ts", "1\n2\n3\n4\n5\n");       // outside src/
}

function checksDir(base: string, ids: string[]): void {
  for (const id of ids) write(base, `checks/${id}.json`, JSON.stringify({ card: id, verify: ["true"], checkPaths: [], sha256: {} }));
  write(base, "checks/notes.txt", "not a check\n");
}

// Log and board: alpha passed; beta passed then failed; gamma failed, passed, then a new acceptance.started;
// delta never judged; omega passed but has no checks file.
function story(): void {
  card("done", "alpha", 1000);
  appendEvent(root, "round.started", { card: "alpha", round: 1, lever: null });
  verdict("alpha", "acceptance.passed");
  card("review", "beta", 600);
  appendEvent(root, "round.started", { card: "beta", round: 1, lever: null });
  verdict("beta", "acceptance.passed");
  verdict("beta", "acceptance.failed");
  card("done", "gamma", 300);
  verdict("gamma", "acceptance.failed");
  verdict("gamma", "acceptance.passed");
  appendEvent(root, "acceptance.started", { card: "gamma", ref: "bandit/gamma", sha: "t", repo: root, base: "b", ratified: true });
  card("backlog", "delta", 50);
  card("done", "omega", 200);
  verdict("omega", "acceptance.passed");
}

const EXPECTED = { costPerAccepted: 700, accepted: 3, tokens: 2100, sourceLines: 7, ratifiedChecks: 2, linesPerCheck: 3.5 };

function cli(...args: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["bun", CLI, "measures", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}
function lastJson(stdout: string): any {
  const lines = stdout.trim().split("\n").filter((l) => l.trim());
  return JSON.parse(lines[lines.length - 1]);
}
const measureEvents = () => readEvents(root).filter((e) => e.type === "measure.read");

describe("seed measures: readMeasures", () => {
  test("cost fields from costReport, source lines, ratified checks, lines per check", async () => {
    const { readMeasures } = await measures();
    story(); srcTree(root); checksDir(root, ["alpha", "beta", "gamma", "delta"]);
    const m = readMeasures(root);
    expect(m).toEqual(EXPECTED);
    const { costReport } = await import(join(SRC, "cost.ts"));
    const c = costReport(root);
    expect({ costPerAccepted: m.costPerAccepted, accepted: m.accepted, tokens: m.tokens })
      .toEqual({ costPerAccepted: c.costPerAccepted, accepted: c.accepted, tokens: c.tokens });
  });

  test("repoDir: src/ and checks/ are read there, the log and board from root", async () => {
    const { readMeasures } = await measures();
    story();
    write(root, "src/ignored.ts", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n"); // root's own src is not the repo's
    const repo = tmp("seed-measures-repo-");
    srcTree(repo); checksDir(repo, ["alpha", "gamma", "omega"]);
    expect(readMeasures(root, repo)).toEqual({ ...EXPECTED, ratifiedChecks: 3, linesPerCheck: 7 / 3 });
  });

  test("no ratified check: linesPerCheck is null; no src/: 0 lines; empty log: no cost", async () => {
    const { readMeasures } = await measures();
    expect(readMeasures(root)).toEqual({ costPerAccepted: null, accepted: 0, tokens: 0, sourceLines: 0, ratifiedChecks: 0, linesPerCheck: null });
    srcTree(root); checksDir(root, ["alpha"]); // a check whose card was never judged
    expect(readMeasures(root)).toEqual({ costPerAccepted: null, accepted: 0, tokens: 0, sourceLines: 7, ratifiedChecks: 0, linesPerCheck: null });
  });
});

describe("seed measures: bandit measures", () => {
  test("--json: the readMeasures object on the last line, and one measure.read event", async () => {
    story(); srcTree(root); checksDir(root, ["alpha", "beta", "gamma", "delta"]);
    const r = cli("--json");
    expect(r.code).toBe(0);
    expect(lastJson(r.stdout)).toEqual(EXPECTED);
    const ev = measureEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ costPerAccepted: 700, sourceLines: 7, ratifiedChecks: 2, linesPerCheck: 3.5 });
  });

  test("text: one line per field, exit 0, one measure.read event", () => {
    story(); srcTree(root); checksDir(root, ["alpha"]);
    const r = cli();
    expect(r.code).toBe(0);
    for (const k of Object.keys(EXPECTED)) expect(r.stdout).toContain(k);
    expect(measureEvents()).toHaveLength(1);
    expect(measureEvents()[0]).toMatchObject({ sourceLines: 7, ratifiedChecks: 1, linesPerCheck: 7 });
  });

  test("two reads around a deletion: progressSince shows lines per check falling", async () => {
    const { progressSince } = await measures();
    story(); srcTree(root); checksDir(root, ["alpha", "beta", "gamma", "delta"]);
    expect(cli("--json").code).toBe(0);
    rmSync(join(root, "src", "a.ts")); // 7 -> 4 lines over 2 checks
    expect(cli("--json").code).toBe(0);
    const p = progressSince(root);
    expect(p.linesPerCheck).toEqual({ previous: 3.5, current: 2, delta: -1.5 });
    expect(p.costPerAccepted).toEqual({ previous: 700, current: 700, delta: 0 });
  });
});

describe("seed measures: progressSince", () => {
  const read = (costPerAccepted: number | null, linesPerCheck: number | null) =>
    appendEvent(root, "measure.read", { costPerAccepted, sourceLines: 0, ratifiedChecks: 0, linesPerCheck });

  test("fewer than two measure.read events: both null", async () => {
    const { progressSince } = await measures();
    expect(progressSince(root)).toEqual({ costPerAccepted: null, linesPerCheck: null });
    read(100, 10);
    expect(progressSince(root)).toEqual({ costPerAccepted: null, linesPerCheck: null });
  });

  test("the two most recent events are compared; delta = current - previous", async () => {
    const { progressSince } = await measures();
    read(900, 50);
    read(800, 40);
    appendEvent(root, "card.completed", { card: "x" }); // other events in between do not count
    read(600, 44);
    expect(progressSince(root)).toEqual({
      costPerAccepted: { previous: 800, current: 600, delta: -200 },
      linesPerCheck: { previous: 40, current: 44, delta: 4 },
    });
  });

  test("a null value on either side makes that field null", async () => {
    const { progressSince } = await measures();
    read(null, 30);
    read(500, 20);
    expect(progressSince(root)).toEqual({ costPerAccepted: null, linesPerCheck: { previous: 30, current: 20, delta: -10 } });
    read(400, null);
    expect(progressSince(root)).toEqual({ costPerAccepted: { previous: 500, current: 400, delta: -100 }, linesPerCheck: null });
  });
});
