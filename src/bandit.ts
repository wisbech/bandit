import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readLedger, type Claim } from "./confidence";

// bandit.ts — the Thompson-sampling governor, installed when the instruments
// converge. Preconditions (checked by banditReady):
//   1. ≥1 measure claim at status corroborated/established (trusted rewards)
//   2. ≥2 live levers with ≥MIN_PULLS pulls each (numeric reward history)
// Until then, the bucket-brigade ledger is the governor (bootstrap).
//
// Each lever carries a Beta(α, β) posterior over "pulling this lever pays".
// strengthen → α += scaled delta; weaken → β += 1; decay → soft count shrink.
// rankLevers samples α/(α+β) from each posterior (Thompson) — principled
// exploration that vanishes as posteriors separate. "Established" becomes a
// probability: P(this lever is best) > 0.95.

const BANDIT_DIR = ".bandit/goal";
const MIN_PULLS = 3;
const P_BEST_THRESHOLD = 0.95;
const PRIOR_ALPHA = 1;   // weak prior — evidence earns conviction
const PRIOR_BETA = 2;    // slightly pessimistic: a lever must pay to be believed

export interface Posterior {
  id: string;
  alpha: number;          // "success mass"
  beta: number;           // failure mass
  mean: number;           // α/(α+β)
  samples: number;
}

function banditPath(root: string): string {
  const d = join(root, BANDIT_DIR);
  mkdirSync(d, { recursive: true });
  return join(d, "bandit.jsonl");
}

// ── POSTERIOR IO (same append-only discipline as the ledger) ──

function appendPosterior(root: string, p: Posterior): void {
  writeFileSync(banditPath(root), JSON.stringify(p) + "\n", { flag: "a" });
}

export function readPosteriors(root: string): Map<string, Posterior> {
  const path = banditPath(root);
  const map = new Map<string, Posterior>();
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as Posterior;
      map.set(p.id, p);
    } catch {}
  }
  return map;
}

export function getPosterior(root: string, leverId: string): Posterior {
  const existing = readPosteriors(root).get(leverId);
  if (existing) return existing;
  return { id: leverId, alpha: PRIOR_ALPHA, beta: PRIOR_BETA, mean: PRIOR_ALPHA / (PRIOR_ALPHA + PRIOR_BETA), samples: 0 };
}

// ── SWAP TRIGGER: instrument convergence preconditions ──

export interface BanditReadiness {
  ready: boolean;
  reasons: string[];
  trustedMeasures: number;
  qualifiedLevers: number;
}

export function banditReady(root: string): BanditReadiness {
  const ledger = readLedger(root);
  const trustedMeasures = [...ledger.values()].filter(
    (c) => c.kind === "measure" && (c.status === "corroborated" || c.status === "established"),
  ).length;
  const levers = [...ledger.values()].filter((c) => c.kind === "lever" && c.status !== "dead");
  const qualifiedLevers = levers.filter((c) => c.pulls >= MIN_PULLS).length;
  const reasons: string[] = [];
  if (trustedMeasures < 1) reasons.push(`needs ≥1 corroborated/established measure (have ${trustedMeasures})`);
  if (qualifiedLevers < 2) reasons.push(`needs ≥2 live levers with ≥${MIN_PULLS} pulls (have ${qualifiedLevers})`);
  return { ready: reasons.length === 0, reasons, trustedMeasures, qualifiedLevers };
}

// ── POSTERIOR UPDATES (called by the refiner alongside strengthen/weaken) ──

// Reward a successful pull. reward 0–1 (scaled measure delta), scaled by
// instrument independence (same as the ledger's corroborations).
export function updateOnPayoff(root: string, leverId: string, reward: number, independentMeasures: number): Posterior {
  const p = getPosterior(root, leverId);
  const gain = Math.min(1, Math.max(0, reward)) * Math.min(3, Math.max(1, independentMeasures)) * 0.5;
  const next: Posterior = {
    ...p,
    alpha: p.alpha + gain,
    beta: p.beta + (1 - Math.min(1, gain)),  // soft failure mass on the rest
    mean: 0, samples: p.samples + 1,
  };
  next.mean = next.alpha / (next.alpha + next.beta);
  appendPosterior(root, next);
  appendBanditEvent(root, { type: "payoff", id: leverId, meanAfter: next.mean, ts: new Date().toISOString() });
  return next;
}

export function updateOnFlat(root: string, leverId: string): Posterior {
  const p = getPosterior(root, leverId);
  const next: Posterior = {
    ...p,
    alpha: p.alpha * 0.9,          // soft evidence decay on the success mass
    beta: p.beta + 0.6,            // flat pull is (soft) failure evidence
    mean: 0, samples: p.samples + 1,
  };
  next.mean = next.alpha / (next.alpha + next.beta);
  appendPosterior(root, next);
  appendBanditEvent(root, { type: "flat", id: leverId, meanAfter: next.mean, ts: new Date().toISOString() });
  return next;
}

// ── THOMPSON SAMPLING RANKING (replaces ε-share when ready) ──

// Sample from each lever's Beta posterior; highest sample wins the next pull.
// As posteriors separate, sampling naturally converges to the winner — the
// bandit IS the annealing schedule.
export function thompsonRank(root: string): { id: string; sample: number; mean: number; samples: number }[] {
  const posteriors = readPosteriors(root);
  const ranked = [...posteriors.values()]
    .map((p) => ({ id: p.id, sample: sampleBeta(p.alpha, p.beta), mean: p.mean, samples: p.samples }))
    .sort((a, b) => b.sample - a.sample);
  return ranked;
}

// P(lever is best) via Monte Carlo over posteriors — but only against
// *qualified* competitors (levers with enough samples to have an opinion).
// A lever with thin evidence can't be "established" just because nobody
// else has a posterior yet.
export function probabilityBest(root: string, leverId: string, iterations = 4000): number {
  const posteriors = [...readPosteriors(root).values()].filter((p) => p.id.startsWith("lever:"));
  const target = posteriors.find((p) => p.id === leverId);
  if (!target || target.samples < MIN_PULLS) return 0; // thin evidence never establishes
  const competitors = posteriors.filter((p) => p.id !== leverId && p.samples >= MIN_PULLS);
  let wins = 0;
  for (let i = 0; i < iterations; i++) {
    const mySample = sampleBeta(target.alpha, target.beta);
    let best = true;
    for (const p of competitors) {
      if (sampleBeta(p.alpha, p.beta) > mySample) { best = false; break; }
    }
    if (best) wins += 1;
  }
  return wins / iterations;
}

// ── STATUS IN BANDIT TERMS ──

export function banditStatus(root: string, leverId: string): { mean: number; pBest: number; status: string } {
  const p = getPosterior(root, leverId);
  const pBest = probabilityBest(root, leverId);
  const status = pBest > P_BEST_THRESHOLD ? "established" : p.mean > 0.5 ? "promising" : "uncertain";
  return { mean: p.mean, pBest, status };
}

// ── Beta sampling (Marsaglia-Tsang via two gamma draws) ──

function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

function sampleGamma(shape: number): number {
  if (shape < 1) {
    // Boost: G(shape+1) * U^(1/shape)
    const u = Math.random();
    return sampleGamma(shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = randn();
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function randn(): number {
  const u1 = Math.random() || 1e-12;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function appendBanditEvent(root: string, e: { type: string; id: string; meanAfter: number; ts: string }): void {
  const d = join(root, BANDIT_DIR);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "bandit-events.jsonl"), JSON.stringify(e) + "\n", { flag: "a" });
}

export function readBanditEvents(root: string, limit = 20): { type: string; id: string; meanAfter: number; ts: string }[] {
  const path = join(root, BANDIT_DIR, "bandit-events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(Boolean).slice(-limit).map((l) => JSON.parse(l));
}

// ── VIEW ──

export function renderBandit(root: string): string {
  const readiness = banditReady(root);
  const lines: string[] = ["═══ BANDIT BANDIT GOVERNOR ═══════════════════════"];
  lines.push(`  readiness: ${readiness.ready ? "READY — thompson sampling active" : "not yet — bucket-brigade governs"}`);
  lines.push(`  trusted measures: ${readiness.trustedMeasures} (need ≥1 corroborated/established)`);
  lines.push(`  qualified levers: ${readiness.qualifiedLevers} (need ≥2 with ≥${MIN_PULLS} pulls)`);
  if (!readiness.ready && readiness.reasons.length) {
    for (const r of readiness.reasons) lines.push(`  · ${r}`);
  }
  const posteriors = [...readPosteriors(root).values()].sort((a, b) => b.mean - a.mean);
  if (posteriors.length > 0) {
    lines.push("");
    for (const p of posteriors) {
      const bar = "█".repeat(Math.round(p.mean * 10)).padEnd(10, "░");
      lines.push(`  ${bar} mean=${p.mean.toFixed(2)}  α=${p.alpha.toFixed(1)} β=${p.beta.toFixed(1)}  ${p.id}`);
    }
  }
  return lines.join("\n");
}