// port-status.ts — the display verb of the harness-neutral port: one read-only snapshot.
// Verdicts come only from the judge's acceptance.passed|failed events (rule 1: proof only).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cardsIn } from "./kernel/card";
import { readEvents } from "./kernel/log";

export type Column = "backlog" | "in-progress" | "review" | "done";
export type CardStatus = {
  id: string; title: string; column: Column; verify: string | null; ratified: boolean;
  verdict: "passed" | "failed" | null; verdictSha: string | null; claimedBy: { pid: number } | null;
};
export type BoardStatus = { columns: Record<Column, string[]>; cards: CardStatus[]; lastEventTs: string | null };

const COLS: Column[] = ["backlog", "in-progress", "review", "done"];

export function status(root: string): BoardStatus {
  const events = readEvents(root);
  const judge = new Map<string, { verdict: "passed" | "failed"; sha: string }>();
  const claim = new Map<string, number>();
  for (const e of events) {
    const id = String(e.card);
    if (e.type === "acceptance.passed" || e.type === "acceptance.failed") {
      judge.set(id, { verdict: e.type === "acceptance.passed" ? "passed" : "failed", sha: String(e.sha) });
    } else if (e.type === "card.claimed") claim.set(id, Number(e.pid));
  }
  const columns = { backlog: [], "in-progress": [], review: [], done: [] } as Record<Column, string[]>;
  const cards: CardStatus[] = [];
  for (const column of COLS) {
    for (const c of cardsIn(root, column)) {
      columns[column].push(c.id);
      const j = judge.get(c.id);
      cards.push({
        id: c.id,
        title: c.frontmatter.title ?? c.id,
        column,
        verify: c.frontmatter.verify ?? null,
        ratified: existsSync(join(root, "checks", `${c.id}.json`)),
        verdict: j?.verdict ?? null,
        verdictSha: j?.sha ?? null,
        claimedBy: column === "in-progress" && claim.has(c.id) ? { pid: claim.get(c.id)! } : null,
      });
    }
  }
  return { columns, cards, lastEventTs: events.length ? events[events.length - 1].ts : null };
}
