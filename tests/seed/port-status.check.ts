// Seed check: port-status. Human-owned; a candidate that edits this file is rejected by the judge.
// Run: bun test ./tests/seed/port-status.check.ts   (the ./ matters: *.check.ts is outside bun's default glob)
//
// The display verb of the harness-neutral port: what a pane, a status line or a dashboard draws from.
// src/port-status.ts exports status(root) -> {
//   columns: { backlog, "in-progress", review, done }: card ids per column, in kernel cardsIn order;
//   cards: one row per card, column order then id order: { id, title, column, verify, ratified, verdict,
//     verdictSha, claimedBy }, where verify = frontmatter verify or null, ratified = <root>/checks/<id>.json
//     exists, verdict/verdictSha = the card's LATEST acceptance.passed | acceptance.failed event ("passed" |
//     "failed", its sha) or null, claimedBy = { pid } of the latest card.claimed, for in-progress cards only;
//   lastEventTs: ts of the last event in readEvents(root), or null }.
// Proof only: card.completed without a judge event is NOT a verdict.
// `bandit status --json` prints that object as the last stdout line; `bandit status` prints a table. Both
// exit 0, also with no .bandit at all, and neither writes anything (no event, no folder).
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, readEvents } from "../../src/kernel/log";

const SRC = join(import.meta.dir, "..", "..", "src");
const MOD = join(SRC, "port-status.ts");
const CLI = join(SRC, "cli.ts");

async function portStatus(): Promise<any> {
  expect(existsSync(MOD)).toBe(true);
  const mod: any = await import(MOD);
  expect(typeof mod.status).toBe("function");
  return mod;
}

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "seed-status-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function board(): void {
  for (const col of ["backlog", "in-progress", "review", "done"]) mkdirSync(join(root, ".bandit", "board", col), { recursive: true });
  mkdirSync(join(root, ".bandit", "events"), { recursive: true });
}
function card(column: string, id: string, o: { title?: string; verify?: string } = {}): void {
  const d = join(root, ".bandit", "board", column, id);
  mkdirSync(d, { recursive: true });
  const fm = [`id: ${id}`];
  if (o.title !== undefined) fm.push(`title: ${o.title}`);
  if (o.verify !== undefined) fm.push(`verify: ${o.verify}`);
  writeFileSync(join(d, "card.md"), `---\n${fm.join("\n")}\n---\n# ${id}\n\n## Task\nDo ${id}.\n`);
}
function ratified(id: string): void {
  mkdirSync(join(root, "checks"), { recursive: true });
  writeFileSync(join(root, "checks", `${id}.json`), JSON.stringify({ card: id, verify: ["true"], checkPaths: [], sha256: {} }));
}
const judged = (id: string, passed: boolean, sha: string) =>
  appendEvent(root, passed ? "acceptance.passed" : "acceptance.failed", { card: id, ref: `bandit/${id}`, sha, base: "b0", ratified: true, gates: [] });

// A board with every case the display must get right.
function seed(): void {
  board();
  card("backlog", "b-two", { title: "Second", verify: "bun test ./x.check.ts" });
  card("backlog", "a-one", { title: "First" });
  card("in-progress", "c-held", { title: "Held", verify: "true" });
  card("in-progress", "d-reclaimed", { title: "Reclaimed twice" });
  card("review", "e-failed", { title: "Failed" });
  card("done", "f-proved", { title: "Proved", verify: "true" });
  card("done", "g-unproved", { title: "Completed, never judged" });
  card("done", "h-flipped", { title: "Failed then passed" });
  card("review", "i-regressed", { title: "Passed then failed" });
  card("done", "j-notitle");
  // a claim in flight: a hidden folder in in-progress is not a card
  mkdirSync(join(root, ".bandit", "board", "in-progress", ".k-pending.123"), { recursive: true });
  writeFileSync(join(root, ".bandit", "board", "in-progress", ".k-pending.123", "card.md"), "---\nid: k-pending\n---\n");
  ratified("f-proved");
  ratified("a-one");
  appendEvent(root, "card.claimed", { card: "c-held", pid: 4242, startedAt: "Mon Oct  5 10:00:00 2026" });
  appendEvent(root, "card.claimed", { card: "d-reclaimed", pid: 1111, startedAt: "x" });
  appendEvent(root, "card.reclaimed", { card: "d-reclaimed", from: { pid: 1111, startedAt: "x" } });
  appendEvent(root, "card.claimed", { card: "d-reclaimed", pid: 2222, startedAt: "y" });
  appendEvent(root, "card.claimed", { card: "e-failed", pid: 3333, startedAt: "z" });
  judged("e-failed", false, "sha-e");
  appendEvent(root, "task.failed", { card: "e-failed", reason: "judge" });
  appendEvent(root, "acceptance.started", { card: "f-proved", ref: "bandit/f-proved", sha: "sha-f" });
  judged("f-proved", true, "sha-f");
  appendEvent(root, "card.completed", { card: "f-proved", verdict: "sha-f" });
  appendEvent(root, "card.completed", { card: "g-unproved" }); // shared mode: no judge
  appendEvent(root, "card.completed", { card: "g-unproved", verdict: "sha-forged" }); // even a verdict field is not the judge
  judged("h-flipped", false, "sha-h1");
  judged("h-flipped", true, "sha-h2");
  appendEvent(root, "acceptance.started", { card: "h-flipped", ref: "bandit/h-flipped", sha: "sha-h3" }); // started is not a verdict
  judged("i-regressed", true, "sha-i1");
  judged("i-regressed", false, "sha-i2");
}

const row = (s: any, id: string) => s.cards.find((c: any) => c.id === id);

describe("seed port-status: status(root)", () => {
  test("columns list card ids per column in id order; hidden claims in flight are not cards", async () => {
    const { status } = await portStatus();
    seed();
    const s = status(root);
    expect(s.columns).toEqual({
      backlog: ["a-one", "b-two"],
      "in-progress": ["c-held", "d-reclaimed"],
      review: ["e-failed", "i-regressed"],
      done: ["f-proved", "g-unproved", "h-flipped", "j-notitle"],
    });
    expect(s.cards.map((c: any) => c.id)).toEqual(["a-one", "b-two", "c-held", "d-reclaimed", "e-failed", "i-regressed", "f-proved", "g-unproved", "h-flipped", "j-notitle"]);
  });

  test("each row has exactly the eight fields", async () => {
    const { status } = await portStatus();
    seed();
    for (const c of status(root).cards) {
      expect(Object.keys(c).sort()).toEqual(["claimedBy", "column", "id", "ratified", "title", "verdict", "verdictSha", "verify"]);
    }
  });

  test("title, column and verify from the card; title falls back to the id, verify to null", async () => {
    const { status } = await portStatus();
    seed();
    const s = status(root);
    expect(row(s, "b-two")).toMatchObject({ title: "Second", column: "backlog", verify: "bun test ./x.check.ts" });
    expect(row(s, "a-one")).toMatchObject({ title: "First", column: "backlog", verify: null });
    expect(row(s, "j-notitle")).toMatchObject({ title: "j-notitle", column: "done", verify: null });
  });

  test("ratified = checks/<id>.json exists in the repo dir", async () => {
    const { status } = await portStatus();
    seed();
    const s = status(root);
    expect(row(s, "f-proved").ratified).toBe(true);
    expect(row(s, "a-one").ratified).toBe(true);
    expect(row(s, "g-unproved").ratified).toBe(false);
    expect(row(s, "c-held").ratified).toBe(false);
  });

  test("verdict comes from the judge's latest event only", async () => {
    const { status } = await portStatus();
    seed();
    const s = status(root);
    expect(row(s, "f-proved")).toMatchObject({ verdict: "passed", verdictSha: "sha-f" });
    expect(row(s, "e-failed")).toMatchObject({ verdict: "failed", verdictSha: "sha-e" });
    expect(row(s, "h-flipped")).toMatchObject({ verdict: "passed", verdictSha: "sha-h2" });
    expect(row(s, "i-regressed")).toMatchObject({ verdict: "failed", verdictSha: "sha-i2" });
    expect(row(s, "a-one")).toMatchObject({ verdict: null, verdictSha: null });
  });

  test("proof only: card.completed without a judge event is not a verdict, even with a verdict field", async () => {
    const { status } = await portStatus();
    seed();
    const g = row(status(root), "g-unproved");
    expect(g.column).toBe("done");
    expect(g.verdict).toBeNull();
    expect(g.verdictSha).toBeNull();
  });

  test("claimedBy: the latest card.claimed, for in-progress cards only", async () => {
    const { status } = await portStatus();
    seed();
    const s = status(root);
    expect(row(s, "c-held").claimedBy).toMatchObject({ pid: 4242 });
    expect(row(s, "d-reclaimed").claimedBy).toMatchObject({ pid: 2222 });
    expect(row(s, "e-failed").claimedBy).toBeNull(); // claimed once, but no longer in progress
    expect(row(s, "a-one").claimedBy).toBeNull();
  });

  test("lastEventTs is the ts of the last event", async () => {
    const { status } = await portStatus();
    seed();
    const evs = readEvents(root);
    expect(status(root).lastEventTs).toBe(evs[evs.length - 1].ts);
  });

  test("an empty board and a directory with no .bandit: empty columns, no cards, lastEventTs null", async () => {
    const { status } = await portStatus();
    const empty = { columns: { backlog: [], "in-progress": [], review: [], done: [] }, cards: [], lastEventTs: null };
    expect(status(root)).toEqual(empty);
    expect(existsSync(join(root, ".bandit"))).toBe(false);
    board();
    expect(status(root)).toEqual(empty);
  });

  test("read-only: no event is appended", async () => {
    const { status } = await portStatus();
    seed();
    const n = readEvents(root).length;
    status(root);
    status(root);
    expect(readEvents(root).length).toBe(n);
  });
});

function cli(...args: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["bun", CLI, "status", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}
function lastJson(stdout: string): any {
  const ls = stdout.trim().split("\n").filter((l) => l.trim());
  return JSON.parse(ls[ls.length - 1]);
}

describe("seed port-status: bandit status", () => {
  test("--json prints status(root) as the last stdout line, exit 0", async () => {
    const { status } = await portStatus();
    seed();
    const r = cli("--json");
    expect(r.code).toBe(0);
    expect(lastJson(r.stdout)).toEqual(JSON.parse(JSON.stringify(status(root))));
  });

  test("the JSON keeps proof only", () => {
    seed();
    const j = lastJson(cli("--json").stdout);
    expect(j.cards.find((c: any) => c.id === "g-unproved").verdict).toBeNull();
    expect(j.cards.find((c: any) => c.id === "f-proved").verdict).toBe("passed");
  });

  test("without --json: a table that names every card, exit 0", () => {
    seed();
    const r = cli();
    expect(r.code).toBe(0);
    for (const id of ["a-one", "b-two", "c-held", "d-reclaimed", "e-failed", "f-proved", "g-unproved", "h-flipped", "i-regressed", "j-notitle"]) expect(r.stdout).toContain(id);
  });

  test("no .bandit: exit 0, empty status, and no .bandit is created", () => {
    const r = cli("--json");
    expect(r.code).toBe(0);
    expect(lastJson(r.stdout)).toEqual({ columns: { backlog: [], "in-progress": [], review: [], done: [] }, cards: [], lastEventTs: null });
    expect(cli().code).toBe(0);
    expect(existsSync(join(root, ".bandit"))).toBe(false);
  });

  test("read-only from the CLI: no event is appended", () => {
    seed();
    const n = readEvents(root).length;
    expect(cli("--json").code).toBe(0);
    expect(cli().code).toBe(0);
    expect(readEvents(root).length).toBe(n);
  });
});
