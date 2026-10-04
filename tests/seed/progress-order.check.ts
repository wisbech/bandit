// Seed check: progress-order. Human-owned; a candidate that edits this file is rejected by the judge.
// Run: bun test ./tests/seed/progress-order.check.ts   (the ./ matters: *.check.ts is outside bun's default glob)
//
// Pull where cost is falling. src/progress.ts exports three functions:
//   leverProgress(history) -> Record<lever, { pulls, flat, lastCost, progress }>
//     history in order; cost of a pull = tokens when accepted, Infinity when not. A pull is PROGRESS when it
//     is accepted and (it is the lever's first accepted pull, or its cost < lastCost). lastCost = cost of the
//     lever's most recent ACCEPTED pull (null before any). progress = (prev - cur) / prev of the last progress
//     pull (1 for a first acceptance, 0 before any). Every other pull is flat: flat += 1; progress resets flat to 0.
//   orderFrontier(cards, stats, { maxFlat = 3 }) -> { order, parked }
//     parked: cards whose lever has flat >= maxFlat (id order). order, three groups, each in id order on ties:
//       1. levers with progress > 0, by progress descending
//       2. never-pulled levers (not in stats) and lever-less cards (exploration)
//       3. levers with progress 0 (pulled, never accepted: known flat)
//   leverHistory(root) -> [{ card, lever, accepted, tokens }], one entry per card that has a terminal event
//     (card.completed, task.failed, acceptance.passed, acceptance.failed), in the order of each card's LAST
//     terminal event; lever by the leverOf rule of src/loop.ts (frontmatter `lever:` slug, else the first line
//     under `## Lever`), cards with no lever or no folder omitted; accepted = latest acceptance.passed/failed is
//     passed, or with no acceptance event, a card.completed exists; tokens = lifetimeTokensUsed (0 if absent).
// Wiring: "order": "progress" in .bandit/config.json orders the backlog part of runLoop's frontier with
// orderFrontier(leverProgress(leverHistory(root))), never claims a parked card, and logs card.parked
// { card, lever, flat } once per parked card per pass. Without it: id order, no card.parked.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, readEvents } from "../../src/kernel/log";

const SRC = join(import.meta.dir, "..", "..", "src");
const PROGRESS = join(SRC, "progress.ts");

async function progress(): Promise<any> {
  expect(existsSync(PROGRESS)).toBe(true);
  const mod: any = await import(PROGRESS);
  for (const f of ["leverProgress", "orderFrontier", "leverHistory"]) expect(typeof mod[f]).toBe("function");
  return mod;
}

type Pull = { lever: string; accepted: boolean; tokens: number };
type Stat = { pulls: number; flat: number; lastCost: number | null; progress: number };
const ok = (lever: string, tokens: number): Pull => ({ lever, accepted: true, tokens });
const no = (lever: string, tokens = 0): Pull => ({ lever, accepted: false, tokens });
const st = (pulls: number, flat: number, lastCost: number | null, progress: number): Stat => ({ pulls, flat, lastCost, progress });

describe("seed progress-order: leverProgress", () => {
  const rows: { name: string; history: Pull[]; want: Record<string, Stat> }[] = [
    { name: "empty history", history: [], want: {} },
    { name: "first acceptance is progress 1", history: [ok("L", 1000)], want: { L: st(1, 0, 1000, 1) } },
    { name: "first acceptance after failures resets flat", history: [no("L"), no("L"), ok("L", 800)], want: { L: st(3, 0, 800, 1) } },
    { name: "improving: relative drop", history: [ok("L", 1000), ok("L", 600)], want: { L: st(2, 0, 600, 0.4) } },
    { name: "flat after improving keeps the last progress", history: [ok("L", 1000), ok("L", 600), no("L")], want: { L: st(3, 1, 600, 0.4) } },
    { name: "accepted at the same cost is flat", history: [ok("L", 1000), ok("L", 1000)], want: { L: st(2, 1, 1000, 1) } },
    { name: "accepted dearer is flat, and becomes lastCost", history: [ok("L", 1000), ok("L", 1500)], want: { L: st(2, 1, 1500, 1) } },
    { name: "progress is measured against the previous accepted cost", history: [ok("L", 1000), ok("L", 1500), ok("L", 1200)], want: { L: st(3, 0, 1200, 0.2) } },
    { name: "reset: flat counts consecutive pulls and progress clears it", history: [ok("L", 1000), no("L"), no("L"), ok("L", 500)], want: { L: st(4, 0, 500, 0.5) } },
    { name: "never accepted: flat, no cost, no progress", history: [no("L"), no("L")], want: { L: st(2, 2, null, 0) } },
    { name: "a failed pull's tokens are not a cost", history: [ok("L", 1000), no("L", 10)], want: { L: st(2, 1, 1000, 1) } },
    { name: "three flat pulls after progress", history: [ok("L", 500), no("L"), ok("L", 700), no("L")], want: { L: st(4, 3, 700, 1) } },
    { name: "levers are independent when interleaved", history: [ok("A", 1000), no("B"), ok("A", 500), ok("B", 300)], want: { A: st(2, 0, 500, 0.5), B: st(2, 0, 300, 1) } },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const { leverProgress } = await progress();
      const got = leverProgress(row.history);
      expect(Object.keys(got).sort()).toEqual(Object.keys(row.want).sort());
      for (const [lever, w] of Object.entries(row.want)) {
        expect({ lever, pulls: got[lever].pulls, flat: got[lever].flat, lastCost: got[lever].lastCost })
          .toEqual({ lever, pulls: w.pulls, flat: w.flat, lastCost: w.lastCost });
        expect(got[lever].progress).toBeCloseTo(w.progress, 9);
      }
    });
  }
});

describe("seed progress-order: orderFrontier", () => {
  type C = { id: string; lever: string | null };
  const c = (id: string, lever: string | null = null): C => ({ id, lever });
  const rows: { name: string; cards: C[]; stats: Record<string, Stat>; opts?: { maxFlat?: number }; order: string[]; parked: string[] }[] = [
    { name: "no stats, no levers: id order", cards: [c("c"), c("a"), c("b")], stats: {}, order: ["a", "b", "c"], parked: [] },
    { name: "progress descending", cards: [c("x", "L1"), c("y", "L2"), c("z", "L3")], stats: { L1: st(1, 0, 9, 0.2), L2: st(1, 0, 9, 0.9), L3: st(1, 0, 9, 0.5) }, order: ["y", "z", "x"], parked: [] },
    { name: "equal progress keeps id order", cards: [c("b", "L1"), c("a", "L2")], stats: { L1: st(2, 0, 5, 0.5), L2: st(2, 0, 5, 0.5) }, order: ["a", "b"], parked: [] },
    { name: "parked at flat 3 by default", cards: [c("a", "L1"), c("b", "L2")], stats: { L1: st(4, 3, 9, 1), L2: st(3, 2, 9, 0.1) }, order: ["b"], parked: ["a"] },
    { name: "custom maxFlat 2 parks flat 2", cards: [c("a", "L1"), c("b", "L2")], stats: { L1: st(4, 3, 9, 1), L2: st(3, 2, 9, 0.1) }, opts: { maxFlat: 2 }, order: [], parked: ["a", "b"] },
    { name: "custom maxFlat 5 keeps flat 3", cards: [c("b", "L2"), c("a", "L1")], stats: { L1: st(4, 3, 9, 1), L2: st(1, 0, 9, 0.5) }, opts: { maxFlat: 5 }, order: ["a", "b"], parked: [] },
    { name: "no lever: after progress, before known-flat", cards: [c("a"), c("b", "Lp"), c("c", "Lf")], stats: { Lp: st(1, 0, 9, 0.3), Lf: st(1, 1, null, 0) }, order: ["b", "a", "c"], parked: [] },
    { name: "never-pulled lever explores with lever-less cards, id order", cards: [c("b"), c("a", "Lnew"), c("c", "Lp")], stats: { Lp: st(1, 0, 9, 0.1) }, order: ["c", "a", "b"], parked: [] },
    { name: "progress > 0 with flat 2 stays in the progress group", cards: [c("a", "L0"), c("b", "Lpf"), c("c", "Lnew")], stats: { L0: st(2, 2, null, 0), Lpf: st(3, 2, 9, 0.4) }, order: ["b", "c", "a"], parked: [] },
    { name: "known-flat levers keep id order among themselves", cards: [c("b", "F1"), c("a", "F2")], stats: { F1: st(1, 1, null, 0), F2: st(2, 2, null, 0) }, order: ["a", "b"], parked: [] },
    { name: "a parked lever parks all its cards, id order", cards: [c("c", "Lx"), c("a", "Lx"), c("b")], stats: { Lx: st(5, 4, 9, 1) }, order: ["b"], parked: ["a", "c"] },
    {
      name: "full mix",
      cards: [c("a-flat", "flat"), c("b-new", "fresh"), c("c-hot", "hot"), c("d-none"), c("e-stuck", "stuck"), c("f-first", "first")],
      stats: { flat: st(4, 3, 500, 1), hot: st(2, 0, 500, 0.5), stuck: st(2, 2, null, 0), first: st(1, 0, 200, 1) },
      order: ["f-first", "c-hot", "b-new", "d-none", "e-stuck"],
      parked: ["a-flat"],
    },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const { orderFrontier } = await progress();
      const got = row.opts ? orderFrontier(row.cards, row.stats, row.opts) : orderFrontier(row.cards, row.stats);
      expect(got).toEqual({ order: row.order, parked: row.parked });
    });
  }
});

// ── Board helpers (leverHistory and the loop) ──

let root: string;
let prevCwd: string;
beforeEach(() => {
  prevCwd = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), "seed-progress-")));
  for (const col of ["backlog", "in-progress", "review", "done"]) mkdirSync(join(root, ".bandit", "board", col), { recursive: true });
  mkdirSync(join(root, ".bandit", "events"), { recursive: true });
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
});

// lever: a frontmatter `lever:` value; leverSection: a `## Lever` section instead.
function card(column: string, id: string, o: { lever?: string; leverSection?: string; tokens?: number } = {}): void {
  const d = join(root, ".bandit", "board", column, id);
  mkdirSync(d, { recursive: true });
  const fm = [`id: ${id}`, `title: ${id}`, "verify: true"];
  if (o.lever) fm.push(`lever: ${o.lever}`);
  if (o.tokens !== undefined) fm.push(`lifetimeTokensUsed: ${o.tokens}`);
  const body = [`# ${id}`, "", "## Task", `Do ${id}.`, "", "## Acceptance", "- done", ""];
  if (o.leverSection) body.push("## Lever", o.leverSection, "");
  writeFileSync(join(d, "card.md"), `---\n${fm.join("\n")}\n---\n${body.join("\n")}`);
}
const ev = (type: string, id: string) => appendEvent(root, type, { card: id });

describe("seed progress-order: leverHistory", () => {
  test("one entry per finished card, in order of its last terminal event, lever by the leverOf rule", async () => {
    const { leverHistory } = await progress();
    card("done", "p1", { lever: "Alpha Beta", tokens: 900 });
    card("review", "p2", { leverSection: "Alpha beta", tokens: 400 });
    card("done", "p3", { lever: "gamma", tokens: 300 });
    card("review", "p4", { lever: "gamma", tokens: 250 });
    card("done", "p5", { tokens: 100 });          // no lever: omitted
    card("done", "p8", { lever: "beta" });        // no lifetimeTokensUsed: 0
    card("backlog", "p7", { lever: "gamma", tokens: 5 }); // never finished: omitted
    ev("card.completed", "p1");
    ev("task.failed", "p8");
    ev("task.failed", "p2");
    appendEvent(root, "acceptance.passed", { card: "p3", ref: "r", sha: "s", base: "b", ratified: true, gates: [] });
    ev("card.completed", "p3");
    ev("card.completed", "p5");
    ev("card.completed", "p6");                   // its folder is gone: omitted
    ev("card.moved", "p8");
    ev("card.completed", "p8");                   // failed, reopened, completed: one entry, accepted
    appendEvent(root, "acceptance.passed", { card: "p4", ref: "r", sha: "s", base: "b", ratified: true, gates: [] });
    ev("card.completed", "p4");
    appendEvent(root, "acceptance.failed", { card: "p4", ref: "r", sha: "t", base: "b", ratified: true, gates: [] });
    ev("task.failed", "p4");                      // latest verdict failed: not accepted despite card.completed
    expect(leverHistory(root)).toEqual([
      { card: "p1", lever: "lever:alpha-beta", accepted: true, tokens: 900 },
      { card: "p2", lever: "lever:alpha-beta", accepted: false, tokens: 400 },
      { card: "p3", lever: "lever:gamma", accepted: true, tokens: 300 },
      { card: "p8", lever: "lever:beta", accepted: true, tokens: 0 },
      { card: "p4", lever: "lever:gamma", accepted: false, tokens: 250 },
    ]);
  });

  test("empty log: empty history", async () => {
    const { leverHistory } = await progress();
    card("backlog", "x", { lever: "a" });
    expect(leverHistory(root)).toEqual([]);
  });
});

// ── Wiring: the loop claims in progress order and parks flat levers ──

function serf(name: string): void {
  const d = join(root, ".bandit", "serfs", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "serf.md"), `# ${name}\n\n## Mission\nThe ${name} mission.\n`);
  writeFileSync(join(d, "prompt.md"), `You are ${name}.\nTASK: {{card.task}}\n`);
}

// Prior pulls (finished cards in done/review) and a backlog of six cards whose id order is not the
// progress order. lever:flat had an acceptance, then three flat pulls; lever:hot-path fell 1000 -> 500;
// lever:first was accepted once; lever:stuck failed twice; lever:fresh and d-none were never pulled.
// Failed prior pulls are acceptance.failed (no task.failed, so the refiner stays quiet).
function seedBoard(config: Record<string, unknown>): string {
  for (const name of ["master", "critic", "actor"]) serf(name);
  writeFileSync(join(root, ".bandit", "config.json"), JSON.stringify(config));
  const failed = (id: string) => appendEvent(root, "acceptance.failed", { card: id, ref: `bandit/${id}`, sha: "s", base: "b", ratified: true, gates: [] });
  card("done", "h-flat-0", { lever: "flat", tokens: 500 }); ev("card.completed", "h-flat-0");
  card("done", "h-hot-1", { lever: "hot path", tokens: 1000 }); ev("card.completed", "h-hot-1");
  card("review", "h-flat-1", { lever: "flat", tokens: 700 }); failed("h-flat-1");
  card("review", "h-stuck-1", { lever: "stuck", tokens: 300 }); failed("h-stuck-1");
  card("done", "h-first-1", { lever: "first", tokens: 200 }); ev("card.completed", "h-first-1");
  card("review", "h-flat-2", { lever: "flat", tokens: 400 }); failed("h-flat-2");
  card("done", "h-hot-2", { lever: "hot path", tokens: 500 }); ev("card.completed", "h-hot-2");
  card("review", "h-stuck-2", { lever: "stuck", tokens: 300 }); failed("h-stuck-2");
  card("done", "h-flat-3", { lever: "flat", tokens: 800 }); ev("card.completed", "h-flat-3"); // dearer: flat
  card("backlog", "a-flat", { lever: "flat" });
  card("backlog", "b-new", { lever: "fresh" });
  card("backlog", "c-hot", { leverSection: "Hot path" });
  card("backlog", "d-none");
  card("backlog", "e-stuck", { lever: "stuck" });
  card("backlog", "f-first", { lever: "first" });
  const stub = join(root, "stub.sh");
  writeFileSync(stub, [
    "#!/bin/sh",
    'if echo "$1" | grep -q "Grade the work"; then echo "VERDICT: pass\\nCONFIDENCE: 0.9\\nREASONING: ok"; exit 0; fi',
    'case "$1" in',
    '  *"CONSULT (routing)"*) echo "DECISION: escalate";;',
    '  *) echo "done\\nVERIFICATION_COMMAND: true\\nVERIFICATION_EXIT_CODE: 0\\nVERIFICATION_OUTPUT: fine";;',
    "esac",
  ].join("\n"));
  chmodSync(stub, 0o755);
  return stub;
}

const claimed = () => readEvents(root).filter((e) => e.type === "card.claimed").map((e) => e.card);
const parked = () => readEvents(root).filter((e) => e.type === "card.parked");

describe("seed progress-order: the loop pulls where cost is falling", () => {
  test('"order": "progress": claims follow the progress order, the flat lever\'s card is parked', async () => {
    const stub = seedBoard({ order: "progress" });
    process.chdir(root);
    const loop: any = await import(join(SRC, "loop.ts"));
    const r = await loop.runLoop({ once: true, root, transport: { kind: "headless", command: stub, args: [] }, maxRetries: 1 });
    expect(claimed()).toEqual(["f-first", "c-hot", "b-new", "d-none", "e-stuck"]);
    expect(r.processed).toBe(5);
    const p = parked();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ card: "a-flat", lever: "lever:flat", flat: 3 });
    expect(existsSync(join(root, ".bandit", "board", "backlog", "a-flat", "card.md"))).toBe(true);
  });

  test("default config: unchanged id order, nothing parked", async () => {
    const stub = seedBoard({});
    process.chdir(root);
    const loop: any = await import(join(SRC, "loop.ts"));
    const r = await loop.runLoop({ once: true, root, transport: { kind: "headless", command: stub, args: [] }, maxRetries: 1 });
    expect(claimed()).toEqual(["a-flat", "b-new", "c-hot", "d-none", "e-stuck", "f-first"]);
    expect(r.processed).toBe(6);
    expect(parked()).toHaveLength(0);
  });
});
