// Seed check: folder-router. Human-owned; a candidate that edits this file is rejected by the judge.
// Run: bun test ./tests/seed/folder-router.check.ts   (the ./ matters: *.check.ts is outside bun's default glob)
//
// The serf folders are the routing table. src/router.ts exports
//   routeCandidates(root): Record<serf, mission>   — every .bandit/serfs/<name>/ holding BOTH serf.md and
//     prompt.md, except master and critic; mission = first non-empty paragraph under "## Mission" in serf.md
//     (lines trimmed, joined by one space), else the folder name; at most 300 characters.
//   routeCard(root, card, port) -> { serf, source, probabilities? }, rules in order:
//     1. card.frontmatter.serf names a candidate: that serf, source "card" (port not called)
//     2. fewer than two candidates: the only one, or "actor"; source "default" (port not called)
//     3. port.choose(state with title and task, instructions, candidates): top label >= 0.5 and a
//        candidate: that serf, source "choice", with the probabilities
//     4. anything else (null, throw, below 0.5, unknown label): "actor", source "default"
//   and logs exactly one card.routed { card, serf, source, probabilities? } per call.
// Wiring: with "router": "folders" in .bandit/config.json the loop runs the routed serf's folder as the
// actor; without it nothing changes and no card.routed is logged.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readEvents } from "../../src/kernel/log";

const SRC = join(import.meta.dir, "..", "..", "src");
const ROUTER = join(SRC, "router.ts");

type Choose = (state: string, instructions: string, options: Record<string, string>) => Promise<Record<string, number> | null>;
type Call = { state: string; instructions: string; options: Record<string, string> };

// A decision port whose only live question is choose; it records every call.
function fakePort(choose: Choose, calls: Call[]) {
  return {
    demonstrates: async () => null,
    vacuous: async () => null,
    failureSimilarity: async () => null,
    ask: async () => null,
    choose: async (state: string, instructions: string, options: Record<string, string>) => {
      calls.push({ state, instructions, options });
      return choose(state, instructions, options);
    },
  };
}

async function router(): Promise<any> {
  expect(existsSync(ROUTER)).toBe(true);
  const mod: any = await import(ROUTER);
  expect(typeof mod.routeCard).toBe("function");
  expect(typeof mod.routeCandidates).toBe("function");
  return mod;
}

let root: string;
let prevCwd: string;
beforeEach(() => {
  prevCwd = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), "seed-router-")));
  for (const c of ["backlog", "in-progress", "review", "done"]) mkdirSync(join(root, ".bandit", "board", c), { recursive: true });
  mkdirSync(join(root, ".bandit", "events"), { recursive: true });
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
});

// A serf folder; null leaves serf.md or prompt.md out.
function serf(name: string, opts: { serfMd?: string | null; prompt?: string | null } = {}): void {
  const d = join(root, ".bandit", "serfs", name);
  mkdirSync(d, { recursive: true });
  const serfMd = opts.serfMd === undefined ? `# ${name}\n\n## Mission\nThe ${name} mission.\n` : opts.serfMd;
  const prompt = opts.prompt === undefined ? `You are ${name}.\nTASK: {{card.task}}\n` : opts.prompt;
  if (serfMd !== null) writeFileSync(join(d, "serf.md"), serfMd);
  if (prompt !== null) writeFileSync(join(d, "prompt.md"), prompt);
}

function routedEvents(): any[] {
  return readEvents(root).filter((e) => e.type === "card.routed");
}

const CARD = { id: "parser-tests", title: "Parser tests", task: "Write tests for the card parser.", frontmatter: {} as Record<string, string> };

describe("seed folder-router: routeCandidates reads the folder structure", () => {
  test("only folders with both serf.md and prompt.md; master and critic excluded", async () => {
    const { routeCandidates } = await router();
    serf("master");
    serf("critic");
    serf("actor");
    serf("tester");
    serf("no-prompt", { prompt: null });
    serf("no-identity", { serfMd: null });
    writeFileSync(join(root, ".bandit", "serfs", "stray.md"), "## Mission\nnot a folder\n");
    const c = routeCandidates(root);
    expect(Object.keys(c).sort()).toEqual(["actor", "tester"]);
    expect(c.actor).toBe("The actor mission.");
    expect(c.tester).toBe("The tester mission.");
  });

  test("no serfs folder: no candidates", async () => {
    const { routeCandidates } = await router();
    expect(routeCandidates(root)).toEqual({});
  });

  const missions: { name: string; serfMd: string; mission: string }[] = [
    { name: "first non-empty paragraph under ## Mission", serfMd: "# t\n\n## Mission\n\nWrites tests\nfor the code.\n\nSecond paragraph.\n", mission: "Writes tests for the code." },
    { name: "the paragraph ends at the next heading", serfMd: "# t\n\n## Mission\nGuards the gate.\n## Notes\nnot mission\n", mission: "Guards the gate." },
    { name: "text before ## Mission is not the mission", serfMd: "# t\nIntro text.\n\n## Mission\nReviews diffs.\n", mission: "Reviews diffs." },
    { name: "no ## Mission section: the folder name", serfMd: "# t\n\nSome identity.\n", mission: "t" },
    { name: "an empty ## Mission section: the folder name", serfMd: "# t\n\n## Mission\n\n## Other\nx\n", mission: "t" },
  ];
  for (const m of missions) {
    test(`mission: ${m.name}`, async () => {
      const { routeCandidates } = await router();
      serf("t", { serfMd: m.serfMd });
      expect(routeCandidates(root).t).toBe(m.mission);
    });
  }

  test("the mission is bounded to 300 characters", async () => {
    const { routeCandidates } = await router();
    const long = "x".repeat(250) + " " + "y".repeat(250);
    serf("t", { serfMd: `# t\n\n## Mission\n${long}\n` });
    const got: string = routeCandidates(root).t;
    expect(got.length).toBe(300);
    expect(got).toBe(long.slice(0, 300));
  });
});

describe("seed folder-router: routeCard rules", () => {
  type Row = {
    name: string;
    serfs: string[];
    frontmatter?: Record<string, string>;
    answer: Record<string, number> | null | "throw";
    serf: string;
    source: "card" | "choice" | "default";
    portCalled: boolean;
    probabilities?: boolean; // the answer is returned as probabilities
  };
  const rows: Row[] = [
    { name: "rule 1: frontmatter serf names a candidate", serfs: ["actor", "tester"], frontmatter: { serf: "tester" }, answer: { actor: 0.9, tester: 0.1 }, serf: "tester", source: "card", portCalled: false },
    { name: "rule 1 comes before rule 2 (one candidate, named)", serfs: ["actor", "master"], frontmatter: { serf: "actor" }, answer: null, serf: "actor", source: "card", portCalled: false },
    { name: "rule 1 skipped: frontmatter serf is not a candidate", serfs: ["actor", "tester", "master"], frontmatter: { serf: "master" }, answer: { tester: 0.7, actor: 0.3 }, serf: "tester", source: "choice", portCalled: true, probabilities: true },
    { name: "rule 2: one candidate", serfs: ["tester", "master", "critic"], answer: { actor: 0.99 }, serf: "tester", source: "default", portCalled: false },
    { name: "rule 2: no candidates", serfs: ["master", "critic"], answer: { tester: 0.99 }, serf: "actor", source: "default", portCalled: false },
    { name: "rule 3: confident top label", serfs: ["actor", "tester", "docs"], answer: { actor: 0.2, tester: 0.7, docs: 0.1 }, serf: "tester", source: "choice", portCalled: true, probabilities: true },
    { name: "rule 3: exactly 0.5 is taken", serfs: ["actor", "tester"], answer: { actor: 0.5, tester: 0.3 }, serf: "actor", source: "choice", portCalled: true, probabilities: true },
    { name: "rule 4: below the floor", serfs: ["actor", "tester", "docs"], answer: { actor: 0.3, tester: 0.45, docs: 0.25 }, serf: "actor", source: "default", portCalled: true },
    { name: "rule 4: null answer", serfs: ["actor", "tester"], answer: null, serf: "actor", source: "default", portCalled: true },
    { name: "rule 4: the port throws", serfs: ["actor", "tester"], answer: "throw", serf: "actor", source: "default", portCalled: true },
    { name: "rule 4: top label is not a candidate", serfs: ["actor", "tester"], answer: { master: 0.9, tester: 0.1 }, serf: "actor", source: "default", portCalled: true },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const { routeCard, routeCandidates } = await router();
      for (const s of row.serfs) serf(s);
      const calls: Call[] = [];
      const port = fakePort(async () => {
        if (row.answer === "throw") throw new Error("evaluator down");
        return row.answer;
      }, calls);
      const card = { ...CARD, frontmatter: row.frontmatter ?? {} };
      const r = await routeCard(root, card, port);
      expect(r.serf).toBe(row.serf);
      expect(r.source).toBe(row.source);
      expect(calls.length).toBe(row.portCalled ? 1 : 0);
      if (row.probabilities) expect(r.probabilities).toEqual(row.answer as Record<string, number>);
      if (!row.portCalled) expect(r.probabilities).toBeUndefined();
      if (row.portCalled) {
        expect(calls[0].options).toEqual(routeCandidates(root));
        expect(calls[0].state).toContain(CARD.title);
        expect(calls[0].state).toContain(CARD.task);
        expect(calls[0].instructions.trim().length).toBeGreaterThan(0);
      }
      const ev = routedEvents();
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ card: CARD.id, serf: row.serf, source: row.source });
      if (row.probabilities) expect(ev[0].probabilities).toEqual(row.answer as Record<string, number>);
    });
  }

  test("the candidates offered are the missions read from the folders", async () => {
    const { routeCard } = await router();
    serf("actor", { serfMd: "# actor\n\n## Mission\nImplements features.\n" });
    serf("tester", { serfMd: "# tester\n\n## Mission\nWrites and repairs tests.\n" });
    serf("master");
    const calls: Call[] = [];
    await routeCard(root, CARD, fakePort(async () => ({ tester: 0.8, actor: 0.2 }), calls));
    expect(calls[0].options).toEqual({ actor: "Implements features.", tester: "Writes and repairs tests." });
  });
});

// ── Wiring: the loop runs the routed folder as the actor ──

const STUB_EVALUATOR = "seed-folder-router-stub";
const routerAsks: Call[] = [];

function seedBoard(config: Record<string, unknown>): string {
  for (const name of ["master", "critic"]) serf(name, { prompt: `You are ${name}.\nTASK: {{card.task}}\n` });
  serf("actor", { serfMd: "# actor\n\n## Mission\nImplements features.\n", prompt: "ACTOR-PROMPT-MARKER\nTASK: {{card.task}}\n" });
  serf("tester", { serfMd: "# tester\n\n## Mission\nWrites and repairs tests.\n", prompt: "TESTER-PROMPT-MARKER\nTASK: {{card.task}}\n" });
  writeFileSync(join(root, ".bandit", "config.json"), JSON.stringify(config));
  const d = join(root, ".bandit", "board", "backlog", "parser-tests");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "card.md"), "---\nid: parser-tests\ntitle: Parser tests\nverify: true\n---\n# Parser tests\n\n## Task\nWrite tests for the card parser.\n\n## Acceptance\n- the tests pass\n");
  // The worker logs every prompt it is given, then answers: the grader passes, everything else claims green.
  const log = join(root, "prompts.log");
  const stub = join(root, "stub.sh");
  writeFileSync(stub, [
    "#!/bin/sh",
    `printf '%s\\n=====\\n' "$1" >> '${log}'`,
    'if echo "$1" | grep -q "Grade the work"; then echo "VERDICT: pass\\nCONFIDENCE: 0.9\\nREASONING: ok"; exit 0; fi',
    'case "$1" in',
    '  *"CONSULT (routing)"*) echo "DECISION: escalate";;',
    '  *) echo "done\\nVERIFICATION_COMMAND: true\\nVERIFICATION_EXIT_CODE: 0\\nVERIFICATION_OUTPUT: fine";;',
    "esac",
  ].join("\n"));
  chmodSync(stub, 0o755);
  return stub;
}

describe("seed folder-router: the loop routes through the folders", () => {
  beforeEach(async () => {
    routerAsks.length = 0;
    // No injection seam on runLoop: register a stub evaluator and point config decisions.evaluator at it.
    const decisions: any = await import(join(SRC, "decisions.ts"));
    decisions.registerDecisionAdapter(STUB_EVALUATOR, () => fakePort(async (_s, _i, options) => {
      if ("tester" in options) return { tester: 0.8, actor: 0.2 };
      return null; // any other choice (e.g. the routing consult) falls back as with no evaluator
    }, routerAsks));
  });

  test('"router": "folders": the routed serf\'s prompt runs the card, and card.routed is logged', async () => {
    const stub = seedBoard({ router: "folders", decisions: { evaluator: STUB_EVALUATOR, endpoint: "stub" } });
    process.chdir(root);
    const loop: any = await import(join(SRC, "loop.ts"));
    const r = await loop.runLoop({ once: true, root, transport: { kind: "headless", command: stub, args: [] }, maxRetries: 1 });
    expect(r.processed).toBe(1);
    const prompts = readFileSync(join(root, "prompts.log"), "utf-8");
    expect(prompts).toContain("TESTER-PROMPT-MARKER");
    expect(prompts).not.toContain("ACTOR-PROMPT-MARKER");
    const ev = routedEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ card: "parser-tests", serf: "tester", source: "choice", probabilities: { tester: 0.8, actor: 0.2 } });
    expect(routerAsks.filter((c) => "tester" in c.options)).toHaveLength(1);
  });

  test("default config: unchanged, the actor folder runs the card and nothing is routed", async () => {
    const stub = seedBoard({ decisions: { evaluator: STUB_EVALUATOR, endpoint: "stub" } });
    process.chdir(root);
    const loop: any = await import(join(SRC, "loop.ts"));
    const r = await loop.runLoop({ once: true, root, transport: { kind: "headless", command: stub, args: [] }, maxRetries: 1 });
    expect(r.processed).toBe(1);
    const prompts = readFileSync(join(root, "prompts.log"), "utf-8");
    expect(prompts).toContain("ACTOR-PROMPT-MARKER");
    expect(prompts).not.toContain("TESTER-PROMPT-MARKER");
    expect(routedEvents()).toHaveLength(0);
    expect(routerAsks.filter((c) => "tester" in c.options)).toHaveLength(0);
  });
});
