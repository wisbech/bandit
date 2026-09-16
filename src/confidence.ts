import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// confidence.ts — the confidence ledger (bucket-brigade credit assignment).
// One record per claim (lever | measure | goal-clause). Claims strengthen on
// corroborated payoff, weaken on disconfirmed pulls, decay without
// re-confirmation. Strength is the per-claim convergence depth; plasticity is
// derived from it (never a config dial). Convergence requires positive
// corroboration — silence is never agreement.

export type ClaimKind = "lever" | "measure" | "goal_clause";
export type ClaimStatus = "provisional" | "tested" | "corroborated" | "established" | "dead";

export interface Claim {
  id: string;               // "lever:weekly-verdicts" | "measure:revenue" | "goal:daily-desk"
  kind: ClaimKind;
  strength: number;         // 0–1 corroboration depth
  pulls: number;            // exposure count
  corroborations: number;   // independent measure-movements attributed
  flatPulls: number;        // consecutive pulls with no corroborating delta
  lastPaidOff?: string;     // ISO date of last corroboration
  status: ClaimStatus;
  evidence: string[];       // trajectory citations
}

export interface LedgerEvent {
  type: string;             // "corroborated" | "flat" | "decay" | "revived"
  id: string;
  strengthAfter: number;
  magnitude?: number;       // delta magnitude for strengthen scaling
  ts: string;
}

const LEDGER_DIR = ".bandit/goal";

function ledgerPath(root: string): string {
  const d = join(root, LEDGER_DIR);
  mkdirSync(d, { recursive: true });
  return join(d, "confidence.jsonl");
}

// ── LEDGER IO (append-only records; latest per id wins on read) ──

export function appendRecord(root: string, claim: Claim): void {
  writeFileSync(ledgerPath(root), JSON.stringify(claim) + "\n", { flag: "a" });
}

export function readLedger(root: string): Map<string, Claim> {
  const path = ledgerPath(root);
  const ledger = new Map<string, Claim>();
  if (!existsSync(path)) return ledger;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const claim = JSON.parse(line) as Claim;
      ledger.set(claim.id, claim);
    } catch {}
  }
  return ledger;
}

export function getClaim(root: string, id: string): Claim {
  const existing = readLedger(root).get(id);
  if (existing) return existing;
  return { id, kind: (id.split(":")[0] as ClaimKind) ?? "lever", strength: 0, pulls: 0, corroborations: 0, flatPulls: 0, evidence: [], status: "provisional" };
}

// ── BUCKET-BRIGADE UPDATE RULES ──

const STRENGTHEN_RATE = 0.25;   // α base — scaled by delta magnitude & independence
const WEAKEN_FACTOR = 0.5;      // γ
const DECAY_FACTOR = 0.98;      // per-cycle gentle decay
const ESTABLISHED_THRESHOLD = 0.7;
const CORROBORATED_THRESHOLD = 0.45;
const TESTED_THRESHOLD = 0.2;
const DEAD_AFTER_FLAT = 3;      // consecutive flat pulls kill a lever

function statusFor(strength: number, pulls: number, corroborations: number, flatPulls: number, current: ClaimStatus): ClaimStatus {
  if (flatPulls >= 2 && strength < TESTED_THRESHOLD) return "dead";
  if (strength >= ESTABLISHED_THRESHOLD && corroborations >= 2) return "established";
  if (strength >= CORROBORATED_THRESHOLD) return "corroborated";
  if (strength >= TESTED_THRESHOLD || pulls > 0) return "tested";
  return current === "dead" ? "dead" : "provisional";
}

// Strengthen: pull paid off with a corroborating measure delta.
// magnitude 0–1 scales the gain; independentMeasures pays more than one.
export function strengthen(root: string, claimId: string, magnitude: number, independentMeasures: number, evidence: string): Claim {
  const claim = getClaim(root, claimId);
  const alpha = STRENGTHEN_RATE * Math.min(1, Math.max(0.2, magnitude)) * Math.min(3, Math.max(1, independentMeasures));
  const next: Claim = {
    ...claim,
    strength: Math.min(1, claim.strength + alpha * (1 - claim.strength)),
    pulls: claim.pulls + 1,
    corroborations: claim.corroborations + 1,
    flatPulls: 0,
    lastPaidOff: new Date().toISOString().slice(0, 10),
    evidence: [...claim.evidence.slice(-4), evidence],
    status: claim.status,
  };
  next.status = statusFor(next.strength, next.pulls, next.corroborations, next.flatPulls, next.status);
  appendRecord(root, next);
  appendEvent(root, { type: "corroborated", id: claimId, strengthAfter: next.strength, magnitude, ts: new Date().toISOString() });
  return next;
}

// Weaken: pull produced a flat/negative delta with corroborated instruments.
export function weaken(root: string, claimId: string, evidence: string): Claim {
  const claim = getClaim(root, claimId);
  const next: Claim = {
    ...claim,
    strength: claim.strength * WEAKEN_FACTOR,
    pulls: claim.pulls + 1,
    flatPulls: claim.flatPulls + 1,
    evidence: [...claim.evidence.slice(-4), evidence],
    status: claim.status,
  };
  next.status = statusFor(next.strength, next.pulls, next.corroborations, next.flatPulls, next.status);
  appendRecord(root, next);
  appendEvent(root, { type: next.status === "dead" ? "retired" : "weakened", id: claimId, strengthAfter: next.strength, ts: new Date().toISOString() });
  return next;
}

// Decay: per-cycle gentle decay — established truth must keep surviving live
// checks. Silence never raises confidence; it slowly erodes it.
export function decayAll(root: string): void {
  const ledger = readLedger(root);
  for (const [id, claim] of ledger) {
    if (claim.status === "dead") continue;
    const next: Claim = {
      ...claim,
      strength: Math.max(0, claim.strength * DECAY_FACTOR),
      status: claim.status === "established" && claim.strength * DECAY_FACTOR < ESTABLISHED_THRESHOLD ? "corroborated" : claim.status,
    };
    appendRecord(root, next);
    appendEvent(root, { type: "decay", id, strengthAfter: next.strength, ts: new Date().toISOString() });
  }
}

// Revive: a dead lever with fresh contradicting evidence re-opens (doctrine is
// falsifiable — the instruments can always challenge it).
export function revive(root: string, claimId: string, evidence: string): Claim {
  const claim = getClaim(root, claimId);
  const next: Claim = {
    ...claim,
    strength: TESTED_THRESHOLD,   // restart at the floor, not zero
    flatPulls: 0,
    status: "tested",
    evidence: [...claim.evidence.slice(-4), evidence],
  };
  appendRecord(root, next);
  appendEvent(root, { type: "revived", id: claimId, strengthAfter: next.strength, ts: new Date().toISOString() });
  return next;
}

// ── PLASTICITY (derived per-claim; global = weighted mean × world factors) ──

export function plasticity(claim: Claim): number {
  // plastic = cheap to revise = inverse of corroboration depth
  return Math.max(0, Math.min(1, 1 - claim.strength));
}

export interface WorldSignals {
  measureVolatility: number;   // 0–1: instrument swing vs its own history
  recentKillRate: number;      // 0–1: fraction of recent pulls that died
}

// Global plasticity: mean over open (non-dead) claims, modulated by world noise.
export function globalPlasticity(root: string, world: WorldSignals): number {
  const ledger = readLedger(root);
  const open = [...ledger.values()].filter((c) => c.status !== "dead");
  if (open.length === 0) return 1; // nothing established — everything plastic
  const mean = open.reduce((sum, c) => sum + plasticity(c), 0) / open.length;
  const vol = 0.5 + 0.5 * Math.min(1, world.measureVolatility);     // 0.5–1
  const kill = 0.7 + 0.3 * Math.min(1, world.recentKillRate);       // 0.7–1
  return Math.min(1, mean * vol * kill);
}

// ── MASTER STANDING QUESTION (selection with exploration share) ──

export interface ScoredClaim extends Claim {
  score: number;            // strength × optionality + exploration share
}

// Rank levers for the next pull: established levers scale (exploit), plastic
// ones get an exploration share so pure exploit never starves the future.
export function rankLeversForPull(root: string, share?: number): ScoredLever[] {
  const ledger = readLedger(root);
  const levers = [...ledger.values()].filter((c) => c.kind === "lever" && c.status !== "dead");
  const eps = share ?? explorationShare(root);
  const scored: ScoredLever[] = levers.map((c) => ({
    ...c,
    score: c.strength * (1 - 0.3 * c.flatPulls) + eps * (1 - c.strength),
  }));
  return scored.sort((a, b) => b.score - a.score);
}

export interface ScoredLever extends Claim {
  score: number;
}

// Exploration share: ε of the score space reserved for unproven levers
// (pure exploit starves the future). ε decays with global corroboration.
export function explorationShare(root: string): number {
  const world: WorldSignals = { measureVolatility: 0.5, recentKillRate: 0.2 }; // conservative defaults when telemetry is thin
  return 0.3 * (1 - (1 - globalPlasticity(root, world)) * 0.5); // 0.15–0.3
}

function explorationShareOf(claim: Claim, share: number): number {
  return share * (1 - claim.strength);
}

// wrapper kept for readability in rankLeversForPull
function explorationShareFor(claim: Claim, root: string): number {
  return explorationShareOf(claim, explorationShare(root));
}

void explorationShareFor;

// ── LEDGER EVENTS (audit trail) ──

function appendEvent(root: string, e: LedgerEvent): void {
  const d = join(root, LEDGER_DIR);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "ledger-events.jsonl"), JSON.stringify(e) + "\n", { flag: "a" });
}

export function readLedgerEvents(root: string, limit = 20): LedgerEvent[] {
  const path = join(root, LEDGER_DIR, "ledger-events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(Boolean).slice(-limit).map((l) => JSON.parse(l) as LedgerEvent);
}

// ── VIEW ──

export function renderConfidence(root: string): string {
  const ledger = readLedger(root);
  const lines: string[] = ["═══ BANDIT CONFIDENCE LEDGER ═══════════════════════"];
  if (ledger.size === 0) {
    lines.push("  (no claims yet — pull a lever and the ledger begins)");
    return lines.join("\n");
  }
  const claims = [...ledger.values()].sort((a, b) => b.strength - a.strength);
  for (const c of claims) {
    const bar = "█".repeat(Math.round(c.strength * 10)).padEnd(10, "░");
    lines.push(`  ${bar} ${c.strength.toFixed(2)}  ${c.status.padEnd(13)} ${c.id}  pulls=${c.pulls} corrob=${c.corroborations}${c.flatPulls > 0 ? ` flat=${c.flatPulls}` : ""}`);
  }
  const dead = claims.filter((c) => c.status === "dead").length;
  lines.push(`\n  claims: ${claims.length} (${dead} dead) | plasticity of top claim: ${plasticity(claims[0]).toFixed(2)}`);
  lines.push("  strengthen on corroborated payoff · weaken on flat · decay always · silence is never agreement");
  return lines.join("\n");
}