import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reopenCard, readEvents } from "../src/loop";
import { seedDefaultFolders } from "./v30-helpers";

// bandit reopen: a hand intervention is an event, not a forged board state.

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bandit-reopen-")));
  process.chdir(root);
  seedDefaultFolders(root);
});

afterEach(() => {
  process.chdir("/");
  rmSync(root, { recursive: true, force: true });
});

test("reopenCard moves a card from any column to backlog and emits card.moved by hand", () => {
  const from = join(root, ".bandit", "board", "review", "stuck-card");
  mkdirSync(from, { recursive: true });
  writeFileSync(join(from, "card.md"), "---\ncolumn: review\nid: stuck-card\n---\n# stuck\n");
  reopenCard(root, "stuck-card", "gate was misconfigured");
  const to = join(root, ".bandit", "board", "backlog", "stuck-card");
  expect(existsSync(from)).toBe(false);
  expect(readFileSync(join(to, "card.md"), "utf-8")).toContain("column: backlog");
  const ev = readEvents().find((e) => e.type === "card.moved" && e.card === "stuck-card");
  expect(ev).toMatchObject({ to: "backlog", by: "hand", reason: "gate was misconfigured" });
});

test("reopenCard refuses an unknown card and an empty reason", () => {
  expect(() => reopenCard(root, "nope", "why")).toThrow();
  const d = join(root, ".bandit", "board", "done", "c");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "card.md"), "---\ncolumn: done\nid: c\n---\n");
  expect(() => reopenCard(root, "c", "  ")).toThrow();
  expect(existsSync(d)).toBe(true);
});
