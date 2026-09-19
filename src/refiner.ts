import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// refiner.ts — Continual Harness (2605.09998) × prime-agent /refine.
// Reads the event window, classifies failure signatures, applies small
// evidence-gated CRUD edits to bandit folders. Snapshots before every pass;
// every edit logged to history.jsonl; rollback restores byte-identical folders.
// Base protocol (protocol.md, serf.md, origin.md) is immutable.

const REFINE_DIR = ".bandit/refiner";

function refinerDir(root: string): string {
  const d = join(root, REFINE_DIR);
  mkdirSync(d, { recursive: true });
  return d;
}

export interface FailureSignature {
  kind: "retry_pattern" | "critic_plumbing" | "verification_red" | "container_rejected" | "stall" | "recurring_task" | "oracle_waste";
  count: number;
  cards: string[];
  evidence: string;
}

export interface RefinerEdit {
  target: "memory" | "prompt" | "skill" | "child";
  serf: string;
  op: "add" | "update" | "delete" | "create";
  name?: string;
  content?: string;
  evidence: string;
  reason: string;
}

export interface RefineResult {
  ran: boolean;
  reason?: string;
  signatures: FailureSignature[];
  edits: RefinerEdit[];
  applied: RefinerEdit[];
  skipped: { edit: RefinerEdit; note: string }[];
  snapshot?: string;
}

// ── EVENT WINDOW + SIGNATURES ──

export function classifySignatures(events: { type: string; ts: string; [k: string]: unknown }[]): FailureSignature[] {
  const sigs: FailureSignature[] = [];

  const retryByCard = new Map<string, number>();
  for (const e of events) {
    if (e.type === "task.retry" || e.type === "verification.unchanged_gate") {
      const card = String((e as Record<string, unknown>).card ?? "");
      if (card) retryByCard.set(card, (retryByCard.get(card) ?? 0) + 1);
    }
  }
  for (const [card, count] of retryByCard) {
    if (count >= 2) sigs.push({ kind: "retry_pattern", count, cards: [card], evidence: `card ${card} retried ${count}x` });
  }

  const plumbing = events.filter((e) => e.type === "critic.repair" || e.type === "critic.bypass");
  if (plumbing.length >= 2) {
    sigs.push({ kind: "critic_plumbing", count: plumbing.length, cards: [...new Set(plumbing.map((e) => String((e as Record<string, unknown>).card ?? "")))].slice(0, 3), evidence: `${plumbing.length} critic plumbing events` });
  }

  const reds = events.filter((e) => e.type === "verification.red" || e.type === "verification.container_rejected");
  if (reds.length >= 2) {
    sigs.push({ kind: "verification_red", count: reds.length, cards: [...new Set(reds.map((e) => String((e as Record<string, unknown>).card ?? "")))].slice(0, 3), evidence: `${reds.length} red verification events` });
  }

  const containerRej = events.filter((e) => e.type === "verification.container_rejected");
  if (containerRej.length >= 2) {
    sigs.push({ kind: "container_rejected", count: containerRej.length, cards: containerRej.map((e) => String((e as Record<string, unknown>).card ?? "")).slice(0, 3), evidence: `${containerRej.length} verifications outside the declared container` });
  }

  // Oracle analysis (SoL-Pi appropriation): wasted-work signatures from the
  // gate's self-verification — the loop now KNOWS when the actor's reported
  // exit code didn't match reality, and when reduction failed to pay.
  const selfVerifyMismatches = events.filter((e) => e.type === "gate.selfverify");
  if (selfVerifyMismatches.length >= 2) {
    sigs.push({ kind: "oracle_waste", count: selfVerifyMismatches.length, cards: [...new Set(selfVerifyMismatches.map((e) => String((e as Record<string, unknown>).card ?? "")))].slice(0, 3), evidence: `${selfVerifyMismatches.length} reported verification codes did not match the re-run — actor is guessing or gaming the gate` });
  }
  const badReceipts = events.filter((e) => e.type === "gate.reduce_failed");
  if (badReceipts.length >= 2) {
    sigs.push({ kind: "oracle_waste", count: badReceipts.length, cards: [], evidence: `${badReceipts.length} evidence receipts failed verification — reducer prompt or model needs attention` });
  }

  return sigs;
}

export function shouldTrigger(root: string): { trigger: boolean; reason: string } {
  const events = readEventsWindow(root);
  const sigs = classifySignatures(events);
  const plumbing = sigs.find((s) => s.kind === "critic_plumbing");
  const containerRej = sigs.find((s) => s.kind === "container_rejected");
  if (plumbing && plumbing.count >= 2) return { trigger: true, reason: `critic plumbing x${plumbing.count}` };
  if (containerRej && containerRej.count >= 2) return { trigger: true, reason: `container rejection x${containerRej.count}` };
  const failures = events.filter((e) => e.type === "task.failed").length;
  if (failures >= 3) return { trigger: true, reason: `${failures} task failures` };
  return { trigger: false, reason: "no threshold reached" };
}

function readEventsWindow(root: string): { type: string; ts: string; [k: string]: unknown }[] {
  const eventsDir = join(root, ".bandit", "events");
  if (!existsSync(eventsDir)) return [];
  const out: { type: string; ts: string; [k: string]: unknown }[] = [];
  for (const f of readdirSync(eventsDir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(eventsDir, f), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

// ── SNAPSHOTS + ROLLBACK ──

export function snapshotSerfs(root: string, names: string[]): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const snapDir = join(refinerDir(root), "snapshots", ts);
  mkdirSync(snapDir, { recursive: true });
  for (const name of names) {
    const src = join(root, ".bandit", "serfs", name);
    if (existsSync(src)) cpSync(src, join(snapDir, name), { recursive: true });
  }
  return ts;
}

export function rollbackTo(root: string, snapshotTs: string): boolean {
  const snapDir = join(refinerDir(root), "snapshots", snapshotTs);
  if (!existsSync(snapDir)) return false;
  for (const name of readdirSync(snapDir)) {
    const target = join(root, ".bandit", "serfs", name);
    rmSync(target, { recursive: true, force: true });
    cpSync(join(snapDir, name), target, { recursive: true });
  }
  appendHistory(root, { ts: new Date().toISOString(), action: "rollback", to: snapshotTs, edits: [] });
  return true;
}

function appendHistory(root: string, entry: Record<string, unknown>): void {
  writeFileSync(join(refinerDir(root), "history.jsonl"), JSON.stringify(entry) + "\n", { flag: "a" });
}

export function readHistory(root: string, limit = 10): Record<string, unknown>[] {
  const path = join(refinerDir(root), "history.jsonl");
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8").split("\n").filter(Boolean).slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// ── EVIDENCE-GATED EDIT APPLICATION ──

export function applyEdit(root: string, edit: RefinerEdit): { applied: boolean; note: string } {
  const serfDir = join(root, ".bandit", "serfs", edit.serf);
  if (!existsSync(join(serfDir, "serf.md"))) return { applied: false, note: `bandit ${edit.serf} not a folder` };

  if (edit.target === "memory") {
    if (edit.op === "delete") return { applied: false, note: "memory delete unsupported — demote instead" };
    const memPath = join(serfDir, "memory", "lessons.md");
    const current = existsSync(memPath) ? readFileSync(memPath, "utf-8") : "";
    const content = edit.content ?? "";
    if (content && current.includes(content.slice(0, 60))) return { applied: false, note: "lesson already present" };
    writeFileSync(memPath, `[refine ${new Date().toISOString()}] ${content} (evidence: ${edit.evidence})\n`, { flag: "a" });
    return { applied: true, note: "memory lesson added" };
  }

  if (edit.target === "prompt") {
    if (edit.op !== "update") return { applied: false, note: "prompt supports update only" };
    const promptPath = join(serfDir, "prompt.md");
    if (!existsSync(promptPath)) return { applied: false, note: "no prompt.md" };
    const current = readFileSync(promptPath, "utf-8");
    // Refinement notes APPEND as a section — never replace the prompt body.
    // An edit whose content is not a full prompt is treated as a note.
    const content = edit.content ?? "";
    const isFullPrompt = (content.includes("You are") || content.includes("## ")) && content.length >= current.length;
    // Guard: a full-replacement edit must preserve the template contract.
    const hasTemplateTags = /\{\{card\.task\}\}|\{\{card\.acceptance\}\}/.test(current);
    if (isFullPrompt && hasTemplateTags && !/\{\{card\.task\}\}/.test(content)) {
      return { applied: false, note: "edit would drop {{card.*}} template tags — rejected" };
    }
    const merged = isFullPrompt ? content : current.trimEnd() + "\n\n" + content.trim() + "\n";
    writeFileSync(promptPath, merged);
    return { applied: true, note: isFullPrompt ? "prompt replaced (full rewrite)" : "refinement note appended" };
  }

  if (edit.target === "child") {
    if (edit.op === "create") return { applied: false, note: "child creation goes through master + critic" };
    if (edit.op === "delete") {
      const childFile = join(serfDir, "children", `${edit.name}.md`);
      if (!edit.name || !existsSync(childFile)) return { applied: false, note: "child not found" };
      rmSync(childFile);
      return { applied: true, note: "child registry entry removed" };
    }
  }

  if (edit.target === "skill") {
    const skillsDir = join(root, ".bandit", "knowledge", "skills");
    const gate = skillEvidenceOk(edit.op, edit.evidence);
    if (!gate.ok) return { applied: false, note: gate.note };
    if (!edit.name || !/^[a-z0-9-]+$/i.test(edit.name)) return { applied: false, note: "invalid skill name" };
    const skillDir = join(skillsDir, edit.name);

    if (edit.op === "create") {
      if (existsSync(skillDir)) return { applied: false, note: "skill already exists" };
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "README.md"), `# ${edit.name}\n\nCreated by refiner ${new Date().toISOString()}.\n\n## Description\n${edit.content ?? ""}\n\n## Evidence\n${edit.evidence}\n`);
      return { applied: true, note: "skill created" };
    }
    if (edit.op === "update") {
      if (!existsSync(skillDir)) return { applied: false, note: "skill not found" };
      writeFileSync(join(skillDir, "repair.md"), `# Repair ${new Date().toISOString()}\n\n## Evidence\n${edit.evidence}\n\n## Change\n${edit.content ?? ""}\n`, { flag: "a" });
      return { applied: true, note: "skill repair recorded" };
    }
    if (edit.op === "delete") {
      if (!existsSync(skillDir)) return { applied: false, note: "skill not found" };
      const graveyard = join(skillsDir, ".refiner-retired");
      mkdirSync(graveyard, { recursive: true });
      renameSafe(skillDir, join(graveyard, `${edit.name}.${Date.now().toString(36)}`));
      return { applied: true, note: "skill retired (reversible)" };
    }
  }

  return { applied: false, note: "unknown target" };
}

function renameSafe(from: string, to: string): void {
  try { require("node:fs").renameSync(from, to); } catch {}
}

function skillEvidenceOk(op: RefinerEdit["op"], evidence: string): { ok: boolean; note: string } {
  const ev = evidence.toLowerCase();
  if (op === "create") {
    if (!/\b(x2|x3|x4|x[5-9]|two (similar )?(successful )?runs|three (similar )?(successful )?runs|multiple (successful )?runs|\d+ (similar )?(successful )?runs)/i.test(evidence)) {
      return { ok: false, note: "skill create requires ≥2 similar successful runs in evidence" };
    }
    return { ok: true, note: "" };
  }
  if (op === "update") {
    if (!/trace|exception|error|failed|failure|stack/.test(ev)) return { ok: false, note: "skill repair requires an exception/failure trace in evidence" };
    return { ok: true, note: "" };
  }
  if (op === "delete") {
    if (!/invocation|invoked|never invoked|0 positive|no positive|outcome/.test(ev)) return { ok: false, note: "skill delete requires invocation+outcome evidence" };
    return { ok: true, note: "" };
  }
  return { ok: false, note: "unknown skill op" };
}

// ── THE PASS ──

export async function runRefinePass(root: string, refineFn: (prompt: string) => Promise<string>, options: { force?: boolean } = {}): Promise<RefineResult> {
  const serfs = existsSync(join(root, ".bandit", "serfs")) ? readdirSync(join(root, ".bandit", "serfs")).filter((f) => existsSync(join(root, ".bandit", "serfs", f, "serf.md"))) : [];
  if (serfs.length === 0) return { ran: false, reason: "no folder serfs", signatures: [], edits: [], applied: [], skipped: [] };

  const events = readEventsWindow(root);
  const signatures = classifySignatures(events);
  const trigger = shouldTrigger(root);

  if (!options.force && !trigger.trigger) {
    return { ran: false, reason: trigger.reason, signatures, edits: [], applied: [], skipped: [] };
  }

  // Model floor lives in the caller (config); the refiner refuses weak models there.
  const snapshotTs = snapshotSerfs(root, serfs);
  const context = serfs.map((name) => {
    const statePath = join(root, ".bandit", "serfs", name, "state.md");
    const state = existsSync(statePath) ? readFileSync(statePath, "utf-8").slice(0, 300) : "";
    return `### ${name}\nstate: ${state.replace(/\n/g, " | ")}`;
  }).join("\n");

  const prompt = `You are the bandit refiner. Review the factory trajectory and propose small evidence-backed edits.

## Serfs
${serfs.join(", ")}

## Failure signatures
${signatures.length ? signatures.map((s) => `- ${s.kind} x${s.count} (cards: ${s.cards.join(", ")}) — ${s.evidence}`).join("\n") : "(none)"}

## Serf context
${context}

Respond with ONLY a JSON array of edits (empty [] if nothing warranted):
[{"target":"memory|prompt|skill|child","bandit":"...","op":"add|update|delete|create","name":"...","content":"...","evidence":"<specific citation>","reason":"..."}]

Rules: memory.add for lessons; prompt.update only tied to a signature; skill.create needs ≥2 successful runs cited; skill delete needs invocation+outcome evidence; never touch serf.md or origin.md.`;

  let edits: RefinerEdit[] = [];
  try {
    const text = await refineFn(prompt);
    const match = text.match(/\[[\s\S]*\]/);
    if (match) edits = JSON.parse(match[0]) as RefinerEdit[];
  } catch {
    edits = [];
  }

  const applied: RefinerEdit[] = [];
  const skipped: { edit: RefinerEdit; note: string }[] = [];
  for (const edit of edits.slice(0, 8)) {
    if (!edit.serf || !serfs.includes(edit.serf)) { skipped.push({ edit, note: "unknown serf" }); continue; }
    if (!edit.evidence || edit.evidence.length < 4) { skipped.push({ edit, note: "insufficient evidence" }); continue; }
    const r = applyEdit(root, edit);
    if (r.applied) applied.push(edit);
    else skipped.push({ edit, note: r.note });
  }

  // Confidence ledger updates (bucket-brigade): attribute measure deltas to
  // the active lever. Corroborating delta → strengthen; flat pull → weaken.
  try {
    const conf = await import("./confidence");
    const bandit = await import("./bandit");
    const activeLever = extractActiveLever(root);
    if (activeLever) {
      const corroborating = signatures.length === 0; // clean window = the pull may have paid
      if (corroborating) {
        conf.strengthen(root, activeLever, 0.6, 2, `refine pass ${new Date().toISOString()}: measures corroborated`);
      } else {
        conf.weaken(root, activeLever, `refine pass ${new Date().toISOString()}: ${signatures.map((s) => s.kind).join(",")}`);
      }
      conf.decayAll(root);
      // Bandit governor: dual-write posteriors when the instruments have converged.
      if (bandit.banditReady(root).ready) {
        if (corroborating) bandit.updateOnPayoff(root, activeLever, 0.6, 2);
        else bandit.updateOnFlat(root, activeLever);
        emitSafe(root, "bandit.updated", { lever: activeLever });
      }
      emitSafe(root, "confidence.updated", { lever: activeLever });
    }
  } catch {}

  appendHistory(root, {
    ts: new Date().toISOString(),
    action: "refine",
    trigger: options.force ? "manual" : trigger.reason,
    signatures: signatures.map((s) => s.kind),
    edits: applied.map((e) => ({ serf: e.serf, target: e.target, op: e.op, name: e.name, reason: e.reason })),
    skipped: skipped.map((s) => ({ serf: s.edit.serf, note: s.note })),
    snapshot: snapshotTs,
  });

  return { ran: true, signatures, edits, applied, skipped, snapshot: snapshotTs };
}

// The active lever is recorded in the factory's plan (lever: field) or the
// most recent goal/trajectory note. Simple file convention: .bandit/goal/active-lever.txt
function extractActiveLever(root: string): string | null {
  try {
    const p = join(root, ".bandit", "goal", "active-lever.txt");
    if (!existsSync(p)) return null;
    const id = readFileSync(p, "utf-8").trim();
    return id.startsWith("lever:") ? id : null;
  } catch {
    return null;
  }
}

function emitSafe(root: string, type: string, payload: Record<string, unknown>): void {
  try {
    const { writeFileSync, appendFileSync } = require("node:fs") as typeof import("node:fs");
    const date = new Date().toISOString().slice(0, 10);
    const eventsDir = join(root, ".bandit", "events");
    mkdirSync(eventsDir, { recursive: true });
    appendFileSync(join(eventsDir, `${date}.jsonl`), JSON.stringify({ type, ts: new Date().toISOString(), ...payload }) + "\n");
  } catch {}
}
