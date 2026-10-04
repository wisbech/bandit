// kernel/card.ts — a card is a folder on the board: .bandit/board/<column>/<id>/card.md.
// Parsing, finding, listing, claiming and moving cards, and splitting a card's
// verify: command into argv. Paths come from an explicit board root, never cwd.
//
// Claims, no locks: a claim is a rename out of backlog, and the rename has one
// winner. Every move names the column it expects the card in and fails when
// the card is not there. Who holds a card is the latest card.claimed event.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { appendEvent, readEvents } from "./log";

export const COLUMNS = ["backlog", "in-progress", "review", "done"] as const;
export type Column = (typeof COLUMNS)[number];

export interface CardFolder {
  id: string;
  column: Column;
  dir: string;
  frontmatter: Record<string, string>;
  body: string;
}

export function parseCard(dir: string): CardFolder {
  const raw = readFileSync(join(dir, "card.md"), "utf-8");
  const frontmatter: Record<string, string> = {};
  let body = raw;
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (fmMatch) {
    for (const line of fmMatch[1].split("\n")) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (m) frontmatter[m[1]] = m[2].trim();
    }
    body = raw.slice(fmMatch[0].length);
  }
  // The directory is the only truth for the column. A `column:` line in old
  // cards is ignored; it only names the column of a folder off the board.
  const parent = basename(dirname(dir)) as Column;
  return {
    id: dir.split("/").pop()!,
    column: COLUMNS.includes(parent) ? parent : ((frontmatter.column as Column) ?? "backlog"),
    dir,
    frontmatter,
    body,
  };
}

// Re-resolve a card's directory after a move: search the board for its id.
export function findCardDir(root: string, id: string): string | null {
  for (const col of COLUMNS) {
    const candidate = join(root, ".bandit", "board", col, id);
    if (existsSync(join(candidate, "card.md"))) return candidate;
  }
  return null;
}

export function cardsIn(root: string, column: Column): CardFolder[] {
  const colDir = join(root, ".bandit", "board", column);
  if (!existsSync(colDir)) return [];
  return readdirSync(colDir)
    .filter((name) => !name.startsWith(".")) // .<id>.<pid>: a claim in flight
    .sort() // frontier order = id order (APFS readdir is hash order); numbered titles run in sequence
    .map((name) => readCard(join(colDir, name)))
    .filter((c): c is CardFolder => c !== null);
}

// parseCard, or null when the folder is gone: another loop may claim or move
// a card between listing a column and reading its card.md.
export function readCard(dir: string): CardFolder | null {
  try {
    return parseCard(dir);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    throw e;
  }
}

// A rename that lost a race: the source is gone or the target is taken.
const lostRace = (e: unknown): boolean => ["ENOENT", "EEXIST", "ENOTEMPTY"].includes((e as { code?: string }).code ?? "");

// Fenced move: false (never a throw) when the card is not in `from`.
export function moveCard(root: string, id: string, from: Column, to: Column): boolean {
  const board = join(root, ".bandit", "board");
  mkdirSync(join(board, to), { recursive: true });
  try {
    renameSync(join(board, from, id), join(board, to, id));
    return true;
  } catch (e) {
    if (lostRace(e)) return false;
    throw e;
  }
}

// ── CLAIMS ──

export interface Claimant { pid: number; startedAt: string }

// OS start time of a process, or null when no such process runs. A pid alone
// can be reused; pid + start time names one process.
export function processStart(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().replace(/\s+/g, " ") || null;
  } catch {
    return null;
  }
}

let me: Claimant | null = null;
// This process, read once.
export function self(): Claimant {
  return (me ??= { pid: process.pid, startedAt: processStart(process.pid) ?? "unknown" });
}

export const sameClaimant = (a: Claimant, b: Claimant): boolean => a.pid === b.pid && a.startedAt === b.startedAt;

// kill(pid, 0) is a syscall, not a fork: it cannot fail under load the way ps can.
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM"; // exists, not ours
  }
}

// Dead = no such pid, or the pid now names a process with another start
// time. When ps cannot be read the claimant is assumed alive: a wrong
// "alive" only delays a reclaim, a wrong "dead" works a card twice.
export function claimantAlive(c: Claimant): boolean {
  if (!pidAlive(c.pid)) return false;
  const now = processStart(c.pid);
  return now === null || c.startedAt === "unknown" || now === c.startedAt;
}

export function latestClaim(root: string, id: string): Claimant | null {
  const e = readEvents(root).filter((x) => x.type === "card.claimed" && x.card === id).pop();
  return e ? { pid: Number(e.pid), startedAt: String(e.startedAt) } : null;
}

// backlog/<id> -> in-progress/<id>. False when someone else won. Two renames:
// the card waits under a hidden name until its card.claimed is on the log, so
// a visible in-progress/<id> without a claim is never a claim in flight.
export function claimCard(root: string, id: string, claimant: Claimant = self()): boolean {
  const board = join(root, ".bandit", "board");
  mkdirSync(join(board, "in-progress"), { recursive: true });
  const pending = join(board, "in-progress", `.${id}.${claimant.pid}`);
  try {
    renameSync(join(board, "backlog", id), pending);
  } catch (e) {
    if (lostRace(e)) return false;
    throw e;
  }
  appendEvent(root, "card.claimed", { card: id, pid: claimant.pid, startedAt: claimant.startedAt });
  try {
    renameSync(pending, join(board, "in-progress", id));
  } catch (e) {
    if (lostRace(e)) return false; // recovered from under us as if we were dead
    throw e;
  }
  return true;
}

// A claimant that died: its card goes back to backlog (one winner) and then
// through a normal claim. `from` is the dead claim, null when there was none.
export function reclaimCard(root: string, id: string, from: Claimant | null): boolean {
  if (!moveCard(root, id, "in-progress", "backlog")) return false;
  appendEvent(root, "card.reclaimed", { card: id, from });
  return true;
}

// Claims in flight whose process died between the two renames go back to backlog.
export function recoverPendingClaims(root: string): void {
  const dir = join(root, ".bandit", "board", "in-progress");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const m = name.match(/^\.(.+)\.(\d+)$/);
    if (!m || pidAlive(Number(m[2]))) continue;
    try {
      renameSync(join(dir, name), join(root, ".bandit", "board", "backlog", m[1]));
      appendEvent(root, "card.reclaimed", { card: m[1], from: { pid: Number(m[2]) } });
    } catch (e) {
      if (!lostRace(e)) throw e;
    }
  }
}

// Whitespace split that honours double and single quotes (no escapes, no
// expansion — quotes only group words). No shell ever sees a verify command.
export function splitArgv(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let word = false;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word = true;
    } else if (/\s/.test(ch)) {
      if (word) out.push(cur);
      cur = "";
      word = false;
    } else {
      cur += ch;
      word = true;
    }
  }
  if (word) out.push(cur);
  return out;
}
