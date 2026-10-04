import { describe, expect, test, afterEach, beforeEach, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nullPort, type GaugeQuestion } from "../src/decisions";
import { systemOneAdapter } from "../src/evaluator-systemone";
import { calibrate, gaugeMain, GaugeError, parseExamples, passes, validateGauge, type Gauge } from "../src/gauge";
import { readEvents } from "../src/loop";

// Gauge: typed ask on the port, gauge files, pass rules, the verb's exit
// codes and event, and calibration math — all on a stubbed fetch.

const CFG = { evaluator: "systemone" as const, endpoint: "http://127.0.0.1:9999", timeoutMs: 50 };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

type Answers = Record<string, unknown>;
function answering(fn: (body: any) => Answers | null, seen: any[] = []) {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push(body);
    const answers = fn(body);
    return new Response(JSON.stringify(answers === null ? { nothing: true } : { answers }), { status: 200 });
  }) as unknown as typeof fetch;
  return seen;
}
function refusing() {
  globalThis.fetch = (async () => { throw new TypeError("fetch failed: ECONNREFUSED"); }) as unknown as typeof fetch;
}

const Q: Record<string, GaugeQuestion> = {
  evidence: { type: "noul", instructions: "cites evidence?" },
  spec: { type: "score", instructions: "how specific?", criteria: ["vague", "somewhat", "very"] },
  kind: { type: "choice", instructions: "kind?", criteria: { lesson: "l", todo: "t" } },
};

describe("port ask — normalisation", () => {
  test("noul -> p, score -> value 0..1, choice -> top label + probabilities; one request", async () => {
    const seen = answering(() => ({
      evidence: { type: "noul", noul: 0.4612, confidence: 0.4 },
      spec: { type: "score", score: 1.8, legend: { 0: "vague", 1: "somewhat", 2: "very" }, probabilities: { 0: 0.02, 1: 0.16, 2: 0.82 } },
      kind: { type: "choice", choice: "todo", probabilities: { lesson: 0.3, todo: 0.7 } },
    }));
    const r = await systemOneAdapter(CFG).ask("a note", Q);
    expect(r).toEqual({ evidence: { p: 0.4612 }, spec: { value: 0.9 }, kind: { label: "todo", probabilities: { lesson: 0.3, todo: 0.7 } } });
    expect(seen).toHaveLength(1);
    expect(seen[0].state).toEqual({ body: "a note" });
    expect(seen[0].questions).toEqual(Q);
  });

  test("score falls back to answer/probability (the failureSimilarity shape); values clamp to 0..1", async () => {
    answering(() => ({ evidence: { noul: 1.7 }, spec: { answer: 0.8 }, kind: { probabilities: { lesson: 0.9, todo: 0.1 } } }));
    expect(await systemOneAdapter(CFG).ask("s", Q)).toEqual({ evidence: { p: 1 }, spec: { value: 0.8 }, kind: { label: "lesson", probabilities: { lesson: 0.9, todo: 0.1 } } });
  });

  test("malformed or missing answers -> null (all or nothing)", async () => {
    const good = { evidence: { noul: 0.5 }, spec: { answer: 0.5 }, kind: { probabilities: { lesson: 0.5, todo: 0.5 } } };
    const port = systemOneAdapter(CFG);
    for (const broken of [
      { ...good, evidence: undefined },
      { ...good, evidence: { noul: "x" } },
      { ...good, evidence: 0.5 },
      { ...good, spec: { label: "very" } },
      { ...good, kind: { probabilities: { unknown: 1 } } },
      { ...good, kind: { probabilities: { lesson: Number.NaN } } },
      { ...good, kind: { probabilities: {} } },
      { ...good, kind: { choice: "lesson" } },
    ]) {
      answering(() => broken as Answers);
      expect(await port.ask("s", Q)).toBeNull();
    }
    answering(() => null);
    expect(await port.ask("s", Q)).toBeNull();
    refusing();
    expect(await port.ask("s", Q)).toBeNull();
    expect(await nullPort().ask("s", Q)).toBeNull();
  });

  test("per-call timeout overrides the configured one", async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) => new Promise((res, rej) => {
      const t = setTimeout(() => res(new Response(JSON.stringify({ answers: { evidence: { noul: 0.2 } } }))), 120);
      init.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("The operation timed out.", "TimeoutError")); });
    })) as unknown as typeof fetch;
    const port = systemOneAdapter(CFG); // 50 ms configured
    const one = { evidence: Q.evidence };
    expect(await port.ask("s", one)).toBeNull();
    expect(await port.ask("s", one, 1_000)).toEqual({ evidence: { p: 0.2 } });
  });
});

const STARTER = join(import.meta.dir, "..", "examples", "gauges", "learned-note.json");

describe("gauge files and pass rules", () => {
  test("the committed starter gauge validates and has no thresholds", () => {
    const g = validateGauge(JSON.parse(readFileSync(STARTER, "utf-8")));
    expect(Object.keys(g.questions)).toEqual(["evidence", "actionable", "kind"]);
    expect(Object.values(g.questions).every((q) => q.pass === undefined)).toBe(true);
    const ex = parseExamples(readFileSync(STARTER.replace(".json", ".examples.jsonl"), "utf-8"), g);
    expect(ex).toHaveLength(16);
  });

  test("malformed gauges are usage errors", () => {
    const q = (extra: object) => ({ name: "g", questions: { a: { type: "noul", instructions: "x?", ...extra } } });
    for (const bad of [
      null, [], { questions: {} }, { name: "g", questions: {} }, { name: "g", about: 3, questions: q({}).questions },
      q({ type: "bool" }), q({ instructions: "" }), q({ criteria: ["a", "b"] }),
      q({ type: "choice", criteria: { only: "one" } }), q({ type: "choice", criteria: ["a", "b"] }),
      q({ type: "score", criteria: ["one"] }), q({ type: "score", criteria: { a: "b", c: "d" } }),
      q({ pass: {} }), q({ pass: { min: 1.5 } }), q({ pass: { min: 0.6, max: 0.4 } }), q({ pass: { is: "lesson" } }), q({ pass: { min: 0.5, above: 1 } }),
      q({ type: "choice", criteria: { a: "x", b: "y" }, pass: { is: "c" } }), q({ type: "choice", criteria: { a: "x", b: "y" }, pass: { min: 0.5 } }),
    ]) expect(() => validateGauge(bad)).toThrow(GaugeError);
  });

  test("pass: min, max, both, is; no rule = informational", () => {
    expect(passes({ min: 0.3 }, { p: 0.3 })).toBe(true);
    expect(passes({ min: 0.3 }, { p: 0.29 })).toBe(false);
    expect(passes({ max: 0.2 }, { value: 0.25 })).toBe(false);
    expect(passes({ min: 0.2, max: 0.6 }, { value: 0.6 })).toBe(true);
    expect(passes({ is: "lesson" }, { label: "lesson", probabilities: { lesson: 0.6 } })).toBe(true);
    expect(passes({ is: "lesson" }, { label: "todo", probabilities: { todo: 0.6 } })).toBe(false);
    expect(passes(undefined, { p: 0.9 })).toBeNull();
  });
});

describe("bandit gauge — the verb", () => {
  let root: string;
  const cwd = process.cwd();
  const GAUGE: Gauge = {
    name: "note",
    questions: {
      evidence: { type: "noul", instructions: "cites evidence?", pass: { min: 0.3 } },
      kind: { type: "choice", instructions: "kind?", criteria: { lesson: "l", todo: "t" }, pass: { is: "lesson" } },
      tone: { type: "noul", instructions: "friendly?" },
    },
  };
  function board(gauge: unknown = GAUGE, decisions: unknown = { evaluator: "systemone", endpoint: "http://127.0.0.1:9999", timeoutMs: 50 }) {
    mkdirSync(join(root, ".bandit", "gauges"), { recursive: true });
    writeFileSync(join(root, ".bandit", "gauges", "note.json"), JSON.stringify(gauge));
    writeFileSync(join(root, ".bandit", "config.json"), JSON.stringify(decisions ? { decisions } : {}));
  }
  const reading = (p: number, label: string) => () => ({ evidence: { noul: p }, kind: { probabilities: { lesson: label === "lesson" ? 0.8 : 0.2, todo: label === "lesson" ? 0.2 : 0.8 } }, tone: { noul: 0.5 } });
  const quiet = () => [spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {})];

  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "bandit-gauge-"))); process.chdir(root); });
  afterEach(() => { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); });

  test("exit 0 when every rule passes; one request carries every question, never `pass`", async () => {
    board();
    const seen = answering(reading(0.46, "lesson"));
    const [log, err] = quiet();
    expect(await gaugeMain(["note", "--text", "p99 went 40ms -> 900ms on 2 Oct"])).toBe(0);
    log.mockRestore(); err.mockRestore();
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0].questions)).toEqual(["evidence", "kind", "tone"]);
    expect(JSON.stringify(seen[0].questions)).not.toContain("pass");
  });

  test("exit 1 when any rule fails; gauge.read event carries sha256, readings, verdict", async () => {
    board();
    answering(reading(0.08, "lesson"));
    const file = join(root, "note.md");
    writeFileSync(file, "great sprint everyone");
    const [log, err] = quiet();
    expect(await gaugeMain(["note", "--file", file])).toBe(1);
    log.mockRestore(); err.mockRestore();
    const ev = readEvents().find((e) => e.type === "gauge.read")!;
    expect(ev).toMatchObject({ gauge: "note", source: file, truncated: false, verdict: "fail" });
    expect(ev.sha256).toBe(createHash("sha256").update("great sprint everyone").digest("hex"));
    expect(ev.readings).toEqual({
      evidence: { type: "noul", p: 0.08, pass: false },
      kind: { type: "choice", label: "lesson", probabilities: { lesson: 0.8, todo: 0.2 }, pass: true },
      tone: { type: "noul", p: 0.5, pass: null },
    });
  });

  test("choice rule failing alone is a fail; no rules at all is a pass", async () => {
    board();
    answering(reading(0.9, "todo"));
    const [log, err] = quiet();
    expect(await gaugeMain(["note", "--text", "x"])).toBe(1);
    board({ name: "note", questions: { tone: { type: "noul", instructions: "friendly?" } } });
    answering(() => ({ tone: { noul: 0.01 } }));
    expect(await gaugeMain(["note", "--text", "x", "--json"])).toBe(0);
    log.mockRestore(); err.mockRestore();
  });

  test("exit 2: usage, missing or malformed gauge, no evaluator, unreachable evaluator, malformed answer", async () => {
    const [log, err] = quiet();
    expect(await gaugeMain(["note", "--text", "x"])).toBe(2); // no .bandit
    board();
    answering(reading(0.9, "lesson"));
    expect(await gaugeMain([])).toBe(2);
    expect(await gaugeMain(["nope", "--text", "x"])).toBe(2);
    expect(await gaugeMain(["../x", "--text", "x"])).toBe(2);
    expect(await gaugeMain(["note", "--text", "  "])).toBe(2);
    expect(await gaugeMain(["note", "--file", join(root, "missing.md")])).toBe(2);
    expect(await gaugeMain(["note", "--text", "x", "--timeout-ms", "soon"])).toBe(2);
    board({ name: "note", questions: { a: { type: "noul" } } });
    expect(await gaugeMain(["note", "--text", "x"])).toBe(2);
    board(GAUGE, null);
    expect(await gaugeMain(["note", "--text", "x"])).toBe(2);
    board();
    refusing();
    expect(await gaugeMain(["note", "--text", "x"])).toBe(2);
    answering(() => ({ evidence: { noul: 0.9 } })); // kind and tone missing
    expect(await gaugeMain(["note", "--text", "x"])).toBe(2);
    log.mockRestore(); err.mockRestore();
    expect(readEvents().filter((e) => e.type === "gauge.read")).toHaveLength(0);
  });

  test("the real CLI: stdin is read, unreachable evaluator exits 2", async () => {
    board(GAUGE, { evaluator: "systemone", endpoint: "http://127.0.0.1:1", timeoutMs: 50 });
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const p = Bun.spawn(["bun", cli, "gauge", "note", "--timeout-ms", "200"], { cwd: root, stdin: new TextEncoder().encode("a note"), stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(2);
    expect(await new Response(p.stderr).text()).toContain("no reading");
  });

  test("--calibrate: one request per example, exit 0, never edits the gauge; unreachable -> 2", async () => {
    board();
    const before = readFileSync(join(root, ".bandit", "gauges", "note.json"), "utf-8");
    const examples = join(root, "ex.jsonl");
    writeFileSync(examples, [
      { text: "a", expect: { evidence: true, kind: "lesson" } },
      { text: "b", expect: { evidence: false, kind: "todo" } },
    ].map((e) => JSON.stringify(e)).join("\n"));
    const seen = answering(reading(0.5, "lesson"));
    const [log, err] = quiet();
    expect(await gaugeMain(["note", "--calibrate", examples, "--json"])).toBe(0);
    const out = JSON.parse(String(log.mock.calls[0][0]));
    expect(seen).toHaveLength(2);
    expect(out.questions.kind).toEqual({ type: "choice", n: 2, accuracyAtRule: 0.5 });
    expect(out.questions.tone).toBeUndefined();
    writeFileSync(join(root, "bad.jsonl"), JSON.stringify({ text: "a", expect: { evidence: "yes" } }));
    expect(await gaugeMain(["note", "--calibrate", join(root, "bad.jsonl")])).toBe(2);
    refusing();
    expect(await gaugeMain(["note", "--calibrate", examples])).toBe(2);
    log.mockRestore(); err.mockRestore();
    expect(readFileSync(join(root, ".bandit", "gauges", "note.json"), "utf-8")).toBe(before);
  });
});

describe("calibration math", () => {
  test("accuracy at the rule, best 0.05 threshold with its tie range, separation; choice top-label accuracy", () => {
    const g = validateGauge({
      name: "g",
      questions: {
        evidence: { type: "noul", instructions: "e?", pass: { min: 0.4 } },
        kind: { type: "choice", instructions: "k?", criteria: { lesson: "l", todo: "t" } },
        unasked: { type: "noul", instructions: "u?" },
      },
    });
    const ps = [0.46, 0.30, 0.55, 0.08, 0.12, 0.35];
    const examples = ps.map((_, i) => ({ text: `n${i}`, expect: { evidence: i < 3, ...(i < 3 ? { kind: i === 2 ? "todo" : "lesson" } : {}) } }));
    const readings = ps.map((p) => ({ evidence: { p }, kind: { label: "lesson", probabilities: { lesson: 0.7, todo: 0.3 } }, unasked: { p: 0.5 } }));
    const cal = calibrate(g, examples, readings);
    expect(Object.keys(cal)).toEqual(["evidence", "kind"]);
    expect(cal.evidence.n).toBe(6);
    expect(cal.evidence.accuracyAtRule).toBeCloseTo(5 / 6, 10);
    expect(cal.evidence.best).toEqual({ threshold: 0.15, accuracy: 5 / 6, tiedUpTo: 0.45 });
    expect(cal.evidence.meanTrue).toBeCloseTo((0.46 + 0.30 + 0.55) / 3, 10);
    expect(cal.evidence.meanFalse).toBeCloseTo((0.08 + 0.12 + 0.35) / 3, 10);
    expect(cal.kind).toEqual({ type: "choice", n: 3, accuracyAtRule: 2 / 3 });
  });

  test("no pass rule -> accuracy at rule is null; perfect separation -> accuracy 1", () => {
    const g = validateGauge({ name: "g", questions: { e: { type: "noul", instructions: "e?" } } });
    const cal = calibrate(g, [{ text: "a", expect: { e: true } }, { text: "b", expect: { e: false } }], [{ e: { p: 0.46 } }, { e: { p: 0.08 } }]);
    expect(cal.e.accuracyAtRule).toBeNull();
    expect(cal.e.best).toEqual({ threshold: 0.1, accuracy: 1, tiedUpTo: 0.45 });
  });
});
