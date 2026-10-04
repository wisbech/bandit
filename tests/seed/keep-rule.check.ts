// Seed check: keep-rule. Human-owned; a candidate that edits this file is rejected by the judge.
// Run: bun test ./tests/seed/keep-rule.check.ts   (the ./ matters: *.check.ts is outside bun's default glob)
//
// keepDecision(pairs, total?) in src/keep-rule.ts — the paired sign test for self-edits.
// W = candidate passed where baseline failed, L = baseline passed where candidate failed.
// Concordant pairs are ignored. Abort (revert) as soon as L - W >= 2 at any prefix.
// Keep is judged only once all `total` pairs are in: keep when W - L >= 5. Otherwise revert,
// except an exact tie keeps when candidate tokens were lower on >= 75% of the pairs that carry
// both token counts. Pairs still missing and no abort: continue. Default: revert.
import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

type Pair = { baseline: boolean; candidate: boolean; baselineTokens?: number; candidateTokens?: number };
const W: Pair = { baseline: false, candidate: true };
const L: Pair = { baseline: true, candidate: false };
const BOTH: Pair = { baseline: true, candidate: true };
const NEITHER: Pair = { baseline: false, candidate: false };
const rep = (p: Pair, n: number): Pair[] => Array.from({ length: n }, () => ({ ...p }));
// A tie on outcomes (2 W, 2 L, 8 concordant) with token counts: `lower` of the 12 cheaper for the candidate.
function tie12(lower: number): Pair[] {
  const outcomes = [W, L, W, L, ...rep(BOTH, 8)];
  return outcomes.map((p, i) => ({ ...p, baselineTokens: 1000, candidateTokens: i < lower ? 900 : 1100 }));
}

const modPath = join(import.meta.dir, "..", "..", "src", "keep-rule.ts");
async function keepDecision(pairs: Pair[], total?: number): Promise<{ decision: string; wins: number; losses: number; reason: string }> {
  expect(existsSync(modPath)).toBe(true);
  const mod: any = await import(modPath);
  expect(typeof mod.keepDecision).toBe("function");
  return total === undefined ? mod.keepDecision(pairs) : mod.keepDecision(pairs, total);
}

const table: { name: string; pairs: Pair[]; total?: number; decision: "keep" | "revert" | "continue"; wins: number; losses: number }[] = [
  { name: "five clean wins, all in: keep", pairs: rep(W, 5), decision: "keep", wins: 5, losses: 0 },
  { name: "concordant pairs are ignored", pairs: [...rep(BOTH, 4), ...rep(W, 5), ...rep(NEITHER, 3)], decision: "keep", wins: 5, losses: 0 },
  { name: "six wins one loss: keep", pairs: [W, W, L, W, W, W, W], decision: "keep", wins: 6, losses: 1 },
  { name: "wins minus losses 4, all in: revert", pairs: [...rep(W, 4), ...rep(BOTH, 8)], decision: "revert", wins: 4, losses: 0 },
  { name: "early abort at prefix 2 even though later wins would keep", pairs: [L, L, ...rep(W, 9)], decision: "revert", wins: 0, losses: 2 },
  { name: "abort counts at the prefix where it fired", pairs: [W, L, L, L, W, W, W, W, W, W, W], decision: "revert", wins: 1, losses: 3 },
  { name: "abort does not wait for the remaining pairs", pairs: [L, BOTH, L], total: 12, decision: "revert", wins: 0, losses: 2 },
  { name: "not all in, no abort: continue", pairs: [W, W, BOTH], total: 12, decision: "continue", wins: 2, losses: 0 },
  { name: "keep is judged only when all pairs are in", pairs: rep(W, 5), total: 12, decision: "continue", wins: 5, losses: 0 },
  { name: "one loss ahead is not an abort", pairs: [L, BOTH, W, L], total: 12, decision: "continue", wins: 1, losses: 2 },
  { name: "tie, tokens lower on 9 of 12: keep", pairs: tie12(9), decision: "keep", wins: 2, losses: 2 },
  { name: "tie, tokens lower on 12 of 12: keep", pairs: tie12(12), decision: "keep", wins: 2, losses: 2 },
  { name: "tie, tokens lower on 8 of 12: revert", pairs: tie12(8), decision: "revert", wins: 2, losses: 2 },
  { name: "tie without token data: revert", pairs: [W, L, ...rep(BOTH, 10)], decision: "revert", wins: 1, losses: 1 },
  {
    name: "tie, token data on 4 pairs, lower on 3 (75%): keep",
    pairs: [
      { ...W, baselineTokens: 10, candidateTokens: 5 }, { ...L, baselineTokens: 10, candidateTokens: 5 },
      { ...BOTH, baselineTokens: 10, candidateTokens: 5 }, { ...BOTH, baselineTokens: 10, candidateTokens: 50 }, BOTH, NEITHER,
    ],
    decision: "keep", wins: 1, losses: 1,
  },
  {
    name: "equal tokens are not lower: revert",
    pairs: [W, L, ...rep(BOTH, 10)].map((p) => ({ ...p, baselineTokens: 100, candidateTokens: 100 })),
    decision: "revert", wins: 1, losses: 1,
  },
  { name: "all concordant (0-0 tie, no tokens): revert", pairs: rep(BOTH, 12), decision: "revert", wins: 0, losses: 0 },
  { name: "no pairs at all: revert", pairs: [], decision: "revert", wins: 0, losses: 0 },
  { name: "not a tie, tokens all lower: still revert", pairs: [W, W, L, ...rep(BOTH, 9)].map((p) => ({ ...p, baselineTokens: 100, candidateTokens: 1 })), decision: "revert", wins: 2, losses: 1 },
];

describe("seed keep-rule: keepDecision", () => {
  for (const row of table) {
    test(row.name, async () => {
      const r = await keepDecision(row.pairs, row.total);
      expect({ decision: r.decision, wins: r.wins, losses: r.losses }).toEqual({ decision: row.decision, wins: row.wins, losses: row.losses });
      expect(typeof r.reason).toBe("string");
      expect(r.reason.length).toBeGreaterThan(0);
    });
  }

  test("pure: the input array is not mutated and a second call agrees", async () => {
    const pairs = [L, BOTH, W, ...rep(W, 5)];
    const copy = JSON.parse(JSON.stringify(pairs));
    const a = await keepDecision(pairs);
    const b = await keepDecision(pairs);
    expect(pairs).toEqual(copy);
    expect(b).toEqual(a);
  });
});
