// kernel/card.ts — a card is a folder on the board: .bandit/board/<column>/<id>/card.md.
// Parsing, finding, listing and moving cards, and splitting a card's verify:
// command into argv. Paths come from an explicit board root, never cwd.

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  return {
    id: dir.split("/").pop()!,
    column: (frontmatter.column as Column) ?? "backlog",
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
    .sort() // frontier order = id order (APFS readdir is hash order); numbered titles run in sequence
    .map((name) => join(colDir, name))
    .filter((d) => existsSync(join(d, "card.md")))
    .map((d) => parseCard(d));
}

export function moveCard(root: string, card: CardFolder, to: Column): void {
  // The card may have been moved since it was read — resolve its current dir.
  const current = findCardDir(root, card.id) ?? card.dir;
  const target = join(root, ".bandit", "board", to, card.id);
  renameSync(current, target);
  const cardMd = join(target, "card.md");
  const raw = readFileSync(cardMd, "utf-8").replace(/^column: .+$/m, `column: ${to}`);
  writeFileSync(cardMd, raw);
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
