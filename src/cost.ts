// Cost per judge-accepted card, read from the event log and card frontmatter.
import { readEvents } from "./kernel/log";
import { findCardDir, parseCard } from "./kernel/card";

export type CostReport = {
  cards: number;
  accepted: number;
  rounds: number;
  tokens: number;
  costPerAccepted: number | null;
  results: { id: string; accepted: boolean; rounds: number; tokens: number }[];
};

function cardTokens(root: string, id: string): number {
  const dir = findCardDir(root, id);
  if (!dir) return 0;
  const n = Number(parseCard(dir).frontmatter.lifetimeTokensUsed);
  return Number.isFinite(n) ? n : 0;
}

export function costReport(root: string): CostReport {
  const rounds = new Map<string, number>();
  const verdict = new Map<string, boolean>();
  for (const e of readEvents(root)) {
    if (typeof e.card !== "string") continue;
    if (e.type === "round.started") rounds.set(e.card, (rounds.get(e.card) ?? 0) + 1);
    else if (e.type === "acceptance.passed" || e.type === "acceptance.failed") verdict.set(e.card, e.type === "acceptance.passed");
  }
  const ids = [...new Set([...rounds.keys(), ...verdict.keys()])].sort();
  const results = ids.map((id) => ({ id, accepted: verdict.get(id) ?? false, rounds: rounds.get(id) ?? 0, tokens: cardTokens(root, id) }));
  const accepted = results.filter((r) => r.accepted).length;
  const tokens = results.reduce((s, r) => s + r.tokens, 0);
  return {
    cards: results.length,
    accepted,
    rounds: results.reduce((s, r) => s + r.rounds, 0),
    tokens,
    costPerAccepted: accepted > 0 ? tokens / accepted : null,
    results,
  };
}
