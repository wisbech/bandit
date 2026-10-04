// progress.ts — pull where cost is falling (compression progress).
// A pull is a finished card; its cost is the card's lifetimeTokensUsed when
// accepted. Levers whose cost keeps falling go first, never-pulled levers are
// explored next, known-flat levers last, and levers flat too long are parked.

import { readEvents } from "./kernel/log";
import { parseCard, findCardDir } from "./kernel/card";

export type Pull = { lever: string; accepted: boolean; tokens: number };
export type LeverStat = { pulls: number; flat: number; lastCost: number | null; progress: number };

export function leverOf(card: { frontmatter: Record<string, string>; body: string }): string | null {
  const fm = slugify(card.frontmatter.lever ?? "");
  if (fm) return `lever:${fm}`;
  const m = card.body.match(/## Lever\n([\s\S]*?)(?=\n## |$)/m);
  const first = m?.[1]?.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  const slug = first ? slugify(first).slice(0, 48).replace(/-$/, "") : "";
  return slug ? `lever:${slug}` : null;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const TERMINAL = new Set(["card.completed", "task.failed", "acceptance.passed", "acceptance.failed"]);

export function leverHistory(root: string): Array<{ card: string; lever: string; accepted: boolean; tokens: number }> {
  const last = new Map<string, number>();
  const verdict = new Map<string, boolean>();
  const completed = new Set<string>();
  readEvents(root).forEach((e, i) => {
    const card = typeof e.card === "string" ? e.card : null;
    if (!card || !TERMINAL.has(e.type)) return;
    last.set(card, i);
    if (e.type === "acceptance.passed" || e.type === "acceptance.failed") verdict.set(card, e.type === "acceptance.passed");
    if (e.type === "card.completed") completed.add(card);
  });
  const out: Array<{ card: string; lever: string; accepted: boolean; tokens: number }> = [];
  for (const [card] of [...last].sort((a, b) => a[1] - b[1])) {
    const dir = findCardDir(root, card);
    if (!dir) continue;
    const parsed = parseCard(dir);
    const lever = leverOf(parsed);
    if (!lever) continue;
    const tokens = Number(parsed.frontmatter.lifetimeTokensUsed);
    out.push({ card, lever, accepted: verdict.get(card) ?? completed.has(card), tokens: Number.isFinite(tokens) ? tokens : 0 });
  }
  return out;
}

export function leverProgress(history: Pull[]): Record<string, LeverStat> {
  const stats: Record<string, LeverStat> = {};
  for (const pull of history) {
    const s = (stats[pull.lever] ??= { pulls: 0, flat: 0, lastCost: null, progress: 0 });
    s.pulls += 1;
    const cost = pull.accepted ? pull.tokens : Infinity;
    if (pull.accepted && (s.lastCost === null || cost < s.lastCost)) {
      s.progress = s.lastCost === null ? 1 : (s.lastCost - cost) / s.lastCost;
      s.flat = 0;
      s.lastCost = cost;
    } else {
      s.flat += 1;
      if (pull.accepted) s.lastCost = cost;
    }
  }
  return stats;
}

export function orderFrontier(
  cards: Array<{ id: string; lever: string | null }>,
  stats: Record<string, LeverStat>,
  { maxFlat = 3 }: { maxFlat?: number } = {},
): { order: string[]; parked: string[] } {
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const stat = (c: { lever: string | null }) => (c.lever !== null && Object.hasOwn(stats, c.lever) ? stats[c.lever] : null);
  const parked = [], hot = [], fresh = [], cold = [];
  for (const c of cards) {
    const s = stat(c);
    if (s && s.flat >= maxFlat) parked.push(c);
    else if (s && s.progress > 0) hot.push(c);
    else if (!s) fresh.push(c);
    else cold.push(c);
  }
  hot.sort((a, b) => stat(b)!.progress - stat(a)!.progress || byId(a, b));
  const ids = (xs: typeof cards) => xs.map((c) => c.id);
  return {
    order: [...ids(hot), ...ids(fresh.sort(byId)), ...ids(cold.sort(byId))],
    parked: ids(parked.sort(byId)),
  };
}
