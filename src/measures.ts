// Progress measures: cost per accepted card, and source lines per ratified check, plus their change
// between the two most recent `measure.read` events. Measures only; nothing acts on these numbers.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readEvents } from "./kernel/log";
import { costReport } from "./cost";

export type Measures = {
  costPerAccepted: number | null; accepted: number; tokens: number;
  sourceLines: number; ratifiedChecks: number; linesPerCheck: number | null;
};
export type Change = { previous: number; current: number; delta: number };

// Every line of every *.ts file under dir, blank and comment lines included: a crude
// description-length proxy, not a measure of logic.
function tsLines(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += tsLines(p);
    else if (e.isFile() && e.name.endsWith(".ts")) {
      const s = readFileSync(p, "utf-8");
      n += s.split("\n").length - 1 + (s.length > 0 && !s.endsWith("\n") ? 1 : 0);
    }
  }
  return n;
}

export function readMeasures(root: string, repoDir: string = root): Measures {
  const { costPerAccepted, accepted, tokens } = costReport(root);
  const sourceLines = tsLines(join(repoDir, "src"));
  const verdict = new Map<string, boolean>();
  for (const e of readEvents(root)) {
    if (typeof e.card === "string" && (e.type === "acceptance.passed" || e.type === "acceptance.failed")) verdict.set(e.card, e.type === "acceptance.passed");
  }
  const checks = join(repoDir, "checks");
  const ratifiedChecks = existsSync(checks)
    ? readdirSync(checks).filter((f) => f.endsWith(".json") && verdict.get(f.slice(0, -".json".length)) === true).length
    : 0;
  return { costPerAccepted, accepted, tokens, sourceLines, ratifiedChecks, linesPerCheck: ratifiedChecks > 0 ? sourceLines / ratifiedChecks : null };
}

export function progressSince(root: string): { costPerAccepted: Change | null; linesPerCheck: Change | null } {
  const reads = readEvents(root).filter((e) => e.type === "measure.read");
  const change = (key: "costPerAccepted" | "linesPerCheck"): Change | null => {
    if (reads.length < 2) return null;
    const previous = reads[reads.length - 2][key];
    const current = reads[reads.length - 1][key];
    if (typeof previous !== "number" || typeof current !== "number") return null;
    return { previous, current, delta: current - previous };
  };
  return { costPerAccepted: change("costPerAccepted"), linesPerCheck: change("linesPerCheck") };
}
