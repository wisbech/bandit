// decisions.ts — the decision PORT. bandit's loop consumes only this
// interface; evaluators (Laya, TypeSafe Jev, a future harness, a human
// review queue) are adapters behind it. If no evaluator is configured,
// every method returns null and the loop runs exactly as it would have —
// the port is the decoupling, fail-closed is the contract.
//
// Dependency inversion per the harness principle: bandit knows WHAT it
// wants to ask (the question types in its own vocabulary); it never knows
// WHO answers or over what wire protocol. The adapter owns that.

export interface DecisionPort {
  // Does the verification output actually demonstrate the acceptance criteria?
  // Returns probability 0..1, or null when no evaluator / unreachable / unsure.
  demonstrates(acceptance: string, verificationOutput: string): Promise<number | null>;

  // Is this verification command vacuous — passes even if no work was done?
  vacuous(command: string): Promise<number | null>;

  // How similar are two rounds' failures? 0 = different problems, 1 = same failure.
  failureSimilarity(previous: string, current: string): Promise<number | null>;
}

export interface DecisionConfig {
  evaluator: "none" | "systemone"; // adapters register additional names here
  endpoint: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

// Generic config loader: reads .bandit/config.json decisions section.
// Legacy `"laya": {...}` configs map to evaluator "systemone" (same wire).
export function loadDecisionConfig(root: string): DecisionConfig | null {
  try {
    const cfg = JSON.parse(readFileSync(join(root, ".bandit", "config.json"), "utf-8"));
    if (cfg.decisions?.evaluator) {
      if (cfg.decisions.evaluator === "none") return null;
      return {
        evaluator: cfg.decisions.evaluator,
        endpoint: cfg.decisions.endpoint,
        apiKey: cfg.decisions.apiKey,
        model: cfg.decisions.model,
        timeoutMs: cfg.decisions.timeoutMs,
      };
    }
    // legacy laya config → systemone adapter
    if (cfg.laya?.enabled) {
      return {
        evaluator: "systemone",
        endpoint: cfg.laya.endpoint ?? "http://127.0.0.1:8770",
        apiKey: cfg.laya.apiKey,
        model: cfg.laya.model,
        timeoutMs: cfg.laya.timeoutMs,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Adapter resolution: the loop asks for "the decision port" and gets whatever
// evaluator is configured — or a null port when none is. Adding a new
// evaluator = new adapter file, one line in the registry. Zero loop changes.
export interface DecisionPortFactory {
  (cfg: DecisionConfig): DecisionPort;
}

const ADAPTERS: Record<string, DecisionPortFactory> = {};

export function registerDecisionAdapter(name: string, factory: DecisionPortFactory): void {
  ADAPTERS[name] = factory;
}

export function resolveDecisionPort(cfg: DecisionConfig | null): DecisionPort {
  if (!cfg) return nullPort();
  const factory = ADAPTERS[cfg.evaluator];
  if (!factory) return nullPort();
  try {
    return factory(cfg);
  } catch {
    return nullPort();
  }
}

// The null port: every question answered with "no evaluator" — fail-closed.
export function nullPort(): DecisionPort {
  return {
    demonstrates: async () => null,
    vacuous: async () => null,
    failureSimilarity: async () => null,
  };
}

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Register the SystemOne adapter (Laya serve / TypeSafe Jev — same wire).
// Kept beside the port so the default install works with zero config beyond
// the endpoint. Other adapters register the same way from their own files.
import { systemOneAdapter } from "./evaluator-systemone";
registerDecisionAdapter("systemone", systemOneAdapter);

// ── Question vocabulary (bandit's own words — adapters translate, never the loop) ──

export interface DecisionQuestions {
  demonstrates: string; // acceptance criteria text
  verificationOutput: string; // bounded gate output
  verificationCommand?: string;
  previousFailure?: string;
  currentFailure?: string;
}

// One call site in the loop: ask everything the port can answer, get
// probabilities, emit events. The loop stays ignorant of the evaluator.
export async function askRoundGate(
  port: DecisionPort,
  q: DecisionQuestions,
): Promise<{ demonstrates: number | null; vacuous: number | null; failureSimilarity: number | null }> {
  const [demonstrates, vacuity, similarity] = await Promise.all([
    q.verificationOutput ? port.demonstrates(q.demonstrates, q.verificationOutput) : Promise.resolve(null),
    q.verificationCommand ? port.vacuous(q.verificationCommand) : Promise.resolve(null),
    q.previousFailure && q.currentFailure ? port.failureSimilarity(q.previousFailure, q.currentFailure) : Promise.resolve(null),
  ]);
  return { demonstrates, vacuous: vacuity, failureSimilarity: similarity };
}