import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, readEvents, verifyLog, logHeads, eventFiles, WRITER } from "../src/kernel/log";

// The kernel log: one hash-chained segment per writer process per day.

let root: string;
const LOG = join(import.meta.dir, "..", "src", "kernel", "log.ts");
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "bandit-kernel-log-"))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function segment(): string {
  const files = eventFiles(root).filter((f) => f.includes(`.${WRITER}.`));
  expect(files).toHaveLength(1);
  return files[0];
}

function writeTen(): string {
  for (let n = 0; n < 10; n++) appendEvent(root, "tick", { n });
  return segment();
}

function cliVerify(): number {
  return Bun.spawnSync(["bun", CLI, "log", "verify"], { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode;
}

test("a segment's chain verifies; events carry writer, seq and prev", () => {
  const file = writeTen();
  const lines = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(lines[0].prev).toBeNull();
  expect(lines[1].prev).toMatch(/^[0-9a-f]{64}$/);
  expect(lines.every((e) => e.writer === WRITER)).toBe(true);
  const r = verifyLog(root);
  expect(r.segments).toEqual([{ file: file.split("/").pop()!, events: 10, ok: true }]);
  expect(Object.keys(logHeads(root))).toEqual([file.split("/").pop()!]);
  expect(cliVerify()).toBe(0);
});

test("editing one byte of a middle line fails verify at that seq", () => {
  const file = writeTen();
  const raw = readFileSync(file, "utf-8");
  expect(raw).toContain('"n":5}');
  writeFileSync(file, raw.replace('"n":5}', '"n":7}'));
  const s = verifyLog(root).segments[0];
  expect(s.ok).toBe(false);
  expect(s.brokenAt).toBe(5);
  expect(cliVerify()).toBe(1);
});

test("deleting a middle line fails verify", () => {
  const file = writeTen();
  const lines = readFileSync(file, "utf-8").split("\n");
  lines.splice(4, 1);
  writeFileSync(file, lines.join("\n"));
  const s = verifyLog(root).segments[0];
  expect(s.ok).toBe(false);
  expect(s.brokenAt).toBe(4);
});

test("payload keys cannot overwrite type, ts, writer, seq or prev", () => {
  appendEvent(root, "real", { n: 0 });
  appendEvent(root, "real", { type: "forged", ts: "1999-01-01T00:00:00.000Z", writer: "someone", seq: 99, prev: "f00", keep: 1 });
  const lines = readFileSync(segment(), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines[1]).toMatchObject({ type: "real", writer: WRITER, seq: 1, keep: 1 });
  expect(lines[1].ts).not.toBe("1999-01-01T00:00:00.000Z");
  expect(lines[1].prev).toMatch(/^[0-9a-f]{64}$/);
  expect(verifyLog(root).segments[0].ok).toBe(true);
});

test("two processes appending concurrently: two segments, both verify, merged read of 400", async () => {
  const script = `const { appendEvent } = await import(${JSON.stringify(LOG)}); for (let i = 0; i < 200; i++) appendEvent(${JSON.stringify(root)}, "load", { i });`;
  const procs = [0, 1].map(() => Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" }));
  expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0]);
  const r = verifyLog(root);
  expect(r.segments).toHaveLength(2);
  expect(r.segments.every((s) => s.ok && s.events === 200)).toBe(true);
  const events = readEvents(root);
  expect(events).toHaveLength(400);
  expect(new Set(events.map((e) => e.writer)).size).toBe(2);
  // merged order: ts, then writer, then seq
  for (let i = 1; i < events.length; i++) {
    const [a, b] = [events[i - 1], events[i]];
    const key = (e: typeof a) => [e.ts, String(e.writer), String(e.seq).padStart(6, "0")].join(" ");
    expect(key(a) <= key(b)).toBe(true);
  }
  expect(cliVerify()).toBe(0);
});

test("a legacy unsuffixed file is read and reported pre-genesis, not a failure", () => {
  mkdirSync(join(root, ".bandit", "events"), { recursive: true });
  writeFileSync(join(root, ".bandit", "events", "2026-09-11.jsonl"), '{"type":"card.created","ts":"2026-09-11T00:00:00Z","card":"old"}\n');
  appendEvent(root, "card.created", { card: "new" });
  const r = verifyLog(root);
  expect(r.preGenesis).toEqual(["2026-09-11.jsonl"]);
  expect(r.segments).toHaveLength(1);
  expect(readEvents(root).map((e) => e.card)).toEqual(["old", "new"]);
  expect(cliVerify()).toBe(0);
});
