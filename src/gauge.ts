// gauge.ts — a fast, typed reading of the fluffy qualities of a text ("does
// this note cite evidence?") over the decision port. A gauge is a file of
// questions; a reading is probabilities; a `pass` rule turns a reading into a
// verdict, so `verify: bandit gauge <name> --file <path>` is a card gate.
// Thresholds come from labelled examples (--calibrate), never from intuition.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDecisionConfig, resolveDecisionPort, type DecisionPort, type GaugeAnswer, type GaugeQuestion } from "./decisions";
import { STATE_CEILING } from "./evaluator-systemone";
import { emit } from "./loop";

export interface PassRule { min?: number; max?: number; is?: string }
export interface Gauge { name: string; about?: string; questions: Record<string, GaugeQuestion & { pass?: PassRule }> }
export type Reading = GaugeAnswer & { type: GaugeQuestion["type"]; pass: boolean | null };
export interface Example { text: string; expect: Record<string, boolean | string> }

// Usage problems (bad file, bad flags, no evaluator): the CLI maps these to exit 2.
export class GaugeError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const inUnit = (v: unknown) => typeof v === "number" && v >= 0 && v <= 1;

export function validateGauge(g: unknown, where = "gauge"): Gauge {
  const bad = (m: string): never => { throw new GaugeError(`${where}: ${m}`); };
  if (!isObj(g)) bad("not a JSON object");
  const { name, about, questions } = g as Record<string, unknown>;
  if (typeof name !== "string" || !name) bad('"name" must be a non-empty string');
  if (about !== undefined && typeof about !== "string") bad('"about" must be a string');
  if (!isObj(questions) || Object.keys(questions).length === 0) bad('"questions" must be a non-empty object');
  for (const [id, q] of Object.entries(questions as Record<string, unknown>)) {
    if (!isObj(q)) bad(`question ${id}: not an object`);
    const { type, instructions, criteria, pass } = q as Record<string, unknown>;
    if (type !== "noul" && type !== "score" && type !== "choice") bad(`question ${id}: "type" must be noul | score | choice`);
    if (typeof instructions !== "string" || !instructions.trim()) bad(`question ${id}: "instructions" must be a non-empty string`);
    if (type === "choice" && !(isObj(criteria) && Object.keys(criteria).length >= 2 && Object.values(criteria).every((d) => typeof d === "string")))
      bad(`question ${id}: choice needs "criteria" as {label: description} with at least two labels`);
    if (type === "score" && !(Array.isArray(criteria) && criteria.length >= 2 && criteria.every((c) => typeof c === "string")))
      bad(`question ${id}: score needs "criteria" as an ordered list of at least two labels`);
    if (type === "noul" && criteria !== undefined) bad(`question ${id}: noul takes no "criteria"`);
    if (pass === undefined) continue;
    if (!isObj(pass)) bad(`question ${id}: "pass" must be an object`);
    const { min, max, is, ...rest } = pass as Record<string, unknown>;
    if (Object.keys(rest).length) bad(`question ${id}: unknown pass key(s) ${Object.keys(rest).join(", ")}`);
    if (type === "choice") {
      if (min !== undefined || max !== undefined || typeof is !== "string" || !Object.hasOwn(criteria as object, is))
        bad(`question ${id}: choice pass is {"is": "<one of the criteria labels>"}`);
    } else {
      if (is !== undefined || (min === undefined && max === undefined)) bad(`question ${id}: ${type} pass is {"min"?: 0..1, "max"?: 0..1}`);
      if ((min !== undefined && !inUnit(min)) || (max !== undefined && !inUnit(max))) bad(`question ${id}: pass min/max must be numbers in 0..1`);
      if (typeof min === "number" && typeof max === "number" && min > max) bad(`question ${id}: pass min > max`);
    }
  }
  return g as unknown as Gauge;
}

export function loadGauge(root: string, name: string): Gauge {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) throw new GaugeError(`bad gauge name '${name}'`);
  const path = join(root, ".bandit", "gauges", `${name}.json`);
  if (!existsSync(path)) throw new GaugeError(`no gauge ${name} (looked for .bandit/gauges/${name}.json)`);
  let json: unknown;
  try { json = JSON.parse(readFileSync(path, "utf-8")); } catch { throw new GaugeError(`.bandit/gauges/${name}.json is not valid JSON`); }
  return validateGauge(json, `.bandit/gauges/${name}.json`);
}

// true / false against the rule; null = informational (no rule).
export function passes(rule: PassRule | undefined, a: GaugeAnswer): boolean | null {
  if (!rule) return null;
  if ("label" in a) return a.label === rule.is;
  const v = "p" in a ? a.p : a.value;
  return (rule.min === undefined || v >= rule.min) && (rule.max === undefined || v <= rule.max);
}

// The wire never sees `pass` — that is bandit's business, not the evaluator's.
const wireQuestions = (g: Gauge) =>
  Object.fromEntries(Object.entries(g.questions).map(([id, { pass: _pass, ...q }]) => [id, q])) as Record<string, GaugeQuestion>;

// One request for every question. null = no reading (unconfigured/unreachable/malformed).
export async function readGauge(port: DecisionPort, g: Gauge, text: string, timeoutMs: number): Promise<Record<string, Reading> | null> {
  const answers = await port.ask(text, wireQuestions(g), timeoutMs);
  if (!answers) return null;
  return Object.fromEntries(Object.entries(g.questions).map(([id, q]) => [id, { type: q.type, ...answers[id], pass: passes(q.pass, answers[id]) }]));
}

export function parseExamples(raw: string, g: Gauge): Example[] {
  const out: Example[] = [];
  raw.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const bad = (m: string): never => { throw new GaugeError(`examples line ${i + 1}: ${m}`); };
    let e: unknown;
    try { e = JSON.parse(line); } catch { bad("not valid JSON"); }
    if (!isObj(e) || typeof e.text !== "string" || !e.text.trim() || !isObj(e.expect)) bad('needs {"text": "...", "expect": {...}}');
    const ex = e as unknown as Example;
    for (const [id, v] of Object.entries(ex.expect)) {
      const q = g.questions[id];
      if (!q || !Object.hasOwn(g.questions, id)) bad(`expect.${id}: no such question in gauge ${g.name}`);
      if (q.type === "choice" ? !(typeof v === "string" && Object.hasOwn(q.criteria as object, v)) : typeof v !== "boolean")
        bad(`expect.${id}: ${q.type === "choice" ? "must be one of the criteria labels" : "must be true or false"}`);
    }
    out.push(ex);
  });
  if (out.length === 0) throw new GaugeError("examples file has no examples");
  return out;
}

export interface Calibration {
  type: GaugeQuestion["type"];
  n: number;
  accuracyAtRule: number | null; // null when the question has no pass rule
  // noul/score only: thresholds t in 0.05 steps, predicted true when reading >= t
  best?: { threshold: number; accuracy: number; tiedUpTo: number };
  meanTrue?: number | null;
  meanFalse?: number | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// Pure: readings per example (same order as examples) -> per-question stats.
export function calibrate(g: Gauge, examples: Example[], readings: Record<string, GaugeAnswer>[]): Record<string, Calibration> {
  const out: Record<string, Calibration> = {};
  for (const [id, q] of Object.entries(g.questions)) {
    const rows = examples.flatMap((e, i) => (Object.hasOwn(e.expect, id) ? [{ want: e.expect[id], a: readings[i][id] }] : []));
    if (rows.length === 0) continue;
    const n = rows.length;
    if (q.type === "choice") {
      const hits = rows.filter((r) => "label" in r.a && r.a.label === r.want).length;
      out[id] = { type: q.type, n, accuracyAtRule: hits / n };
      continue;
    }
    const pts = rows.map((r) => ({ want: r.want === true, v: "p" in r.a ? r.a.p : (r.a as { value: number }).value }));
    const accuracyAtRule = q.pass ? pts.filter((x) => passes(q.pass, { p: x.v }) === x.want).length / n : null;
    let best = { threshold: 0, accuracy: -1, tiedUpTo: 0 };
    for (let k = 0; k <= 20; k++) {
      const t = k / 20;
      const acc = pts.filter((x) => x.v >= t === x.want).length / n;
      if (acc > best.accuracy) best = { threshold: t, accuracy: acc, tiedUpTo: t };
      else if (acc === best.accuracy) best.tiedUpTo = t;
    }
    out[id] = {
      type: q.type, n, accuracyAtRule, best,
      meanTrue: mean(pts.filter((x) => x.want).map((x) => x.v)),
      meanFalse: mean(pts.filter((x) => !x.want).map((x) => x.v)),
    };
  }
  return out;
}

const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "-" : v.toFixed(d));

function readingText(r: Reading): string {
  if ("label" in r) return `${r.label} (${fmt(r.probabilities[r.label])})`;
  return "p" in r ? `p=${fmt(r.p)}` : `value=${fmt(r.value)}`;
}

// The verb. Returns the exit code: 0 pass (or no rules), 1 a rule failed,
// 2 usage error or no reading (unconfigured/unreachable — never a pass).
export async function gaugeMain(args: string[]): Promise<number> {
  const root = process.cwd(); // emit() writes under cwd too
  const usage = "usage: bandit gauge <name> (--file <path> | --text <string> | stdin) [--json] [--timeout-ms N]\n       bandit gauge <name> --calibrate <examples.jsonl> [--json] [--timeout-ms N]";
  const flag = (f: string) => { const i = args.indexOf(f); return i >= 0 ? (args[i + 1] ?? "") : undefined; };
  const json = args.includes("--json");
  try {
    const name = args[0];
    if (!existsSync(join(root, ".bandit")) || !name || name.startsWith("--")) throw new GaugeError(usage);
    const tm = flag("--timeout-ms");
    const timeoutMs = tm === undefined ? 30_000 : Number(tm);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new GaugeError("--timeout-ms must be a positive integer");
    const g = loadGauge(root, name);
    const cfg = loadDecisionConfig(root);
    if (!cfg) throw new GaugeError('no evaluator configured — add "decisions": {"evaluator": "systemone", "endpoint": "http://127.0.0.1:8770"} to .bandit/config.json');
    const port = resolveDecisionPort(cfg);
    const unreachable = `no reading from ${cfg.evaluator} at ${cfg.endpoint} (unreachable, timed out after ${timeoutMs}ms, or malformed answer) — no reading is never a pass`;

    const examplesPath = flag("--calibrate");
    if (examplesPath !== undefined) {
      if (!examplesPath || !existsSync(examplesPath)) throw new GaugeError(`--calibrate: no file '${examplesPath}'`);
      const examples = parseExamples(readFileSync(examplesPath, "utf-8"), g);
      const readings: Record<string, GaugeAnswer>[] = [];
      for (const e of examples) {
        const a = await port.ask(e.text, wireQuestions(g), timeoutMs);
        if (!a) throw new GaugeError(unreachable);
        readings.push(a);
      }
      const cal = calibrate(g, examples, readings);
      if (json) console.log(JSON.stringify({ gauge: g.name, examples: examples.length, questions: cal, readings }, null, 2));
      else {
        console.log(`  gauge ${g.name} — ${examples.length} examples`);
        console.log(`  ${"question".padEnd(12)} ${"type".padEnd(7)} ${"n".padStart(3)}  ${"acc@rule".padEnd(9)} ${"best t".padEnd(12)} ${"acc@best".padEnd(9)} ${"mean T".padEnd(7)} mean F`);
        for (const [id, c] of Object.entries(cal)) {
          const bestT = c.best ? (c.best.tiedUpTo > c.best.threshold ? `${fmt(c.best.threshold)}-${fmt(c.best.tiedUpTo)}` : fmt(c.best.threshold)) : "-";
          console.log(`  ${id.padEnd(12)} ${c.type.padEnd(7)} ${String(c.n).padStart(3)}  ${fmt(c.accuracyAtRule).padEnd(9)} ${bestT.padEnd(12)} ${fmt(c.best?.accuracy).padEnd(9)} ${fmt(c.meanTrue).padEnd(7)} ${fmt(c.meanFalse)}`);
        }
        console.log("  choice: acc@rule is top-label accuracy. noul/score: best t predicts true when reading >= t (range = tied thresholds).");
      }
      return 0;
    }

    const file = flag("--file");
    const textFlag = flag("--text");
    if (file !== undefined && textFlag !== undefined) throw new GaugeError("--file and --text are exclusive");
    if (file !== undefined && (!file || !existsSync(file))) throw new GaugeError(`--file: no file '${file}'`);
    const source = file ?? (textFlag !== undefined ? "text" : "stdin");
    const full = file !== undefined ? readFileSync(file, "utf-8") : (textFlag ?? (await Bun.stdin.text()));
    if (!full.trim()) throw new GaugeError("nothing to read: the text is empty");
    // ponytail: one request, cut at the adapter's STATE_CEILING (8,000 chars).
    // Longer texts are read on their head only (flagged `truncated`). Upgrade
    // path: chunk at the ceiling, ask per chunk, aggregate (max for "cites
    // evidence", mean for tone) — when a real gauge needs long texts.
    const truncated = full.length > STATE_CEILING;
    const text = truncated ? full.slice(0, STATE_CEILING) : full;
    const readings = await readGauge(port, g, text, timeoutMs);
    if (!readings) throw new GaugeError(unreachable);
    const verdict = Object.values(readings).some((r) => r.pass === false) ? "fail" : "pass";
    const sha256 = createHash("sha256").update(full).digest("hex");
    mkdirSync(join(root, ".bandit", "events"), { recursive: true });
    emit("gauge.read", { gauge: g.name, source, sha256, truncated, readings, verdict });
    if (json) console.log(JSON.stringify({ gauge: g.name, source, sha256, truncated, readings, verdict }, null, 2));
    else {
      for (const [id, r] of Object.entries(readings))
        console.log(`  ${id.padEnd(12)} ${r.type.padEnd(7)} ${readingText(r).padEnd(24)} ${r.pass === null ? "info" : r.pass ? "pass" : "FAIL"}`);
      console.log(`  ${verdict === "pass" ? "PASS" : "FAIL"} ${g.name}${truncated ? ` (read the first ${STATE_CEILING} chars only)` : ""}`);
    }
    return verdict === "pass" ? 0 : 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2; // anything that is not a reading is not a pass
  }
}
