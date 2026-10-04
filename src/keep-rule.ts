// Paired sign-test keep rule for self-edits (docs/plans/seed.md, Design decisions).
// Keep at +5, abort at -2, exact tie broken by tokens, default revert. Pure.

export type Pair = { baseline: boolean; candidate: boolean; baselineTokens?: number; candidateTokens?: number };
export type KeepDecision = { decision: "keep" | "revert" | "continue"; wins: number; losses: number; reason: string };

export function keepDecision(pairs: Pair[], total: number = pairs.length): KeepDecision {
  let wins = 0;
  let losses = 0;
  for (const p of pairs) {
    if (p.candidate && !p.baseline) wins++;
    else if (p.baseline && !p.candidate) losses++;
    if (losses - wins >= 2) {
      return { decision: "revert", wins, losses, reason: `early abort: losses - wins = ${losses - wins} >= 2` };
    }
  }
  if (pairs.length < total) {
    return { decision: "continue", wins, losses, reason: `${pairs.length} of ${total} pairs in, no abort` };
  }
  if (wins - losses >= 5) {
    return { decision: "keep", wins, losses, reason: `all pairs in: wins - losses = ${wins - losses} >= 5` };
  }
  if (wins === losses) {
    const withData = pairs.filter((p) => typeof p.baselineTokens === "number" && typeof p.candidateTokens === "number");
    const lower = withData.filter((p) => (p.candidateTokens as number) < (p.baselineTokens as number)).length;
    if (withData.length > 0 && lower * 4 >= withData.length * 3) {
      return { decision: "keep", wins, losses, reason: `tie broken by tokens: lower on ${lower} of ${withData.length}` };
    }
    return { decision: "revert", wins, losses, reason: `tie not broken by tokens: lower on ${lower} of ${withData.length}` };
  }
  return { decision: "revert", wins, losses, reason: `default revert: wins - losses = ${wins - losses}` };
}
