// kernel/log.ts — the single owner of the event log (.bandit/events/).
// Every writer appends through appendEvent, every reader reads through
// readEvents or eventFiles. Paths come from an explicit board root, never cwd.
//
// Tamper-evident segments: each process writes its own file per day,
// events/<YYYY-MM-DD>.<writer>.jsonl, so appends need no lock (one
// appendFileSync of one line). Every line carries writer, seq (0-based in its
// segment) and prev (sha256 hex of the previous line's bytes in that segment,
// without the newline; null for seq 0). verifyLog walks the chains. A chain
// cannot show an edit to its own last line; logHeads is the anchor for that.
// Files without a writer in the name (<date>.jsonl, main.jsonl) predate the
// chain: they are read, and reported as pre-genesis by verifyLog.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

export type LogEvent = { type: string; ts: string; [k: string]: unknown };

// Stable for the life of this process.
export const WRITER = `${process.pid}-${Date.now().toString(36)}`;

const SEGMENT = /^(\d{4}-\d{2}-\d{2})\.([A-Za-z0-9-]+)\.jsonl$/;

function eventsDir(root: string): string {
  return join(root, ".bandit", "events");
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

// Every event file on the board (segments and legacy), sorted by name, absolute paths.
export function eventFiles(root: string): string[] {
  const d = eventsDir(root);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(d, f));
}

// Chain head per segment path, as this process last wrote it. `size` lets a
// writer notice the file changed under it (deleted, truncated) and re-read.
const heads = new Map<string, { seq: number; prev: string | null; size: number }>();

function headFromDisk(file: string, size: number): { seq: number; prev: string | null; size: number } {
  if (size <= 0) return { seq: 0, prev: null, size: 0 };
  const lines = readFileSync(file, "utf-8").split("\n").filter((l) => l !== "");
  const last = lines[lines.length - 1];
  let seq = lines.length;
  try { seq = Number(JSON.parse(last).seq) + 1; } catch {}
  return { seq, prev: sha256(last), size };
}

export function appendEvent(root: string, type: string, payload: Record<string, unknown>): void {
  const d = eventsDir(root);
  mkdirSync(d, { recursive: true });
  const ts = new Date().toISOString();
  const file = join(d, `${ts.slice(0, 10)}.${WRITER}.jsonl`);
  let size = 0;
  try { size = statSync(file).size; } catch {}
  let head = heads.get(file);
  if (!head || head.size !== size) head = headFromDisk(file, size);
  // Reserved fields come last from us, never from the payload.
  const { type: _type, ts: _ts, writer: _writer, seq: _seq, prev: _prev, ...rest } = payload;
  const line = JSON.stringify({ type, ts, writer: WRITER, seq: head.seq, prev: head.prev, ...rest });
  appendFileSync(file, line + "\n");
  heads.set(file, { seq: head.seq + 1, prev: sha256(line), size: head.size + Buffer.byteLength(line) + 1 });
}

// All segments plus legacy files, merged by ts, then writer, then seq.
export function readEvents(root: string, sinceTs?: string): LogEvent[] {
  const out: LogEvent[] = [];
  for (const f of eventFiles(root)) {
    for (const line of readFileSync(f, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!sinceTs || e.ts > sinceTs) out.push(e);
      } catch {}
    }
  }
  return out.sort((a, b) =>
    a.ts.localeCompare(b.ts) ||
    String(a.writer ?? "").localeCompare(String(b.writer ?? "")) ||
    Number(a.seq ?? 0) - Number(b.seq ?? 0));
}

export interface SegmentReport { file: string; events: number; ok: boolean; brokenAt?: number }

// brokenAt = the first seq whose bytes the chain does not account for: a line
// that is unparseable, has the wrong seq/writer, or whose successor's prev
// does not match its hash.
function verifySegment(path: string, writer: string): SegmentReport {
  const text = readFileSync(path, "utf-8");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const file = basename(path);
  let prev: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    let e: { seq?: unknown; writer?: unknown; prev?: unknown };
    try { e = JSON.parse(lines[i]); } catch { return { file, events: lines.length, ok: false, brokenAt: i }; }
    if (e.seq !== i || e.writer !== writer) return { file, events: lines.length, ok: false, brokenAt: i };
    if (e.prev !== prev) return { file, events: lines.length, ok: false, brokenAt: Math.max(0, i - 1) };
    prev = sha256(lines[i]);
  }
  return { file, events: lines.length, ok: true };
}

export function verifyLog(root: string): { segments: SegmentReport[]; preGenesis: string[] } {
  const segments: SegmentReport[] = [];
  const preGenesis: string[] = [];
  for (const path of eventFiles(root)) {
    const m = basename(path).match(SEGMENT);
    if (m) segments.push(verifySegment(path, m[2]));
    else preGenesis.push(basename(path));
  }
  return { segments, preGenesis };
}

// sha256 of the last line of every chained segment: the anchor a commit
// trailer carries, so an edit to a segment's tail is visible too.
export function logHeads(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of eventFiles(root)) {
    if (!SEGMENT.test(basename(path))) continue;
    const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l !== "");
    if (lines.length) out[basename(path)] = sha256(lines[lines.length - 1]);
  }
  return out;
}
