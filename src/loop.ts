import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseCard, findCardDir, runSerfOnCard, parseGate, type TransportConfig, type CardFolder } from "./runner";
import {
  COLUMNS, cardsIn as kernelCardsIn, moveCard as kernelMoveCard, claimCard, reclaimCard, recoverPendingClaims, readCard,
  latestClaim, claimantAlive, sameClaimant, self,
} from "./kernel/card";
import { askRoundGate, type DecisionPort } from "./decisions";
import { isolationMode, openWorktree, keepWorktree, discardWorktree } from "./isolation";
import { appendEvent, readEvents as readKernelEvents, type LogEvent } from "./kernel/log";
import { acceptRef as judge } from "./kernel/judge";
import { readScore } from "./kernel/score";

// The decision port (dependency inversion): the loop consumes this interface
// only. Adapters (systemone/laya, jev, future evaluators) live elsewhere and
// register themselves. null = no evaluator; every question returns null.
let decisionPort: DecisionPort | null = null;

// loop.ts — the only imperative code in bandit.
// Poll board → pick frontier card → run pipeline → emit events → refiner check.

export interface LoopConfig {
  root: string;               // project root (contains .bandit/)
  transport: TransportConfig;
  container?: string;
  maxRetries?: number;
  once?: boolean;
  reducer?: { command: string; args: string[] }; // Evidence-Preserving Reducer (cheap model)
  workDir?: string;           // per card, isolation mode: the card's worktree (default: root)
  branch?: string;            // per card, isolation mode: bandit/<card-id>, carried by `converged`
}

function dir(...parts: string[]): string {
  return join(process.cwd(), ".bandit", ...parts);
}

function ensureScaffold(): void {
  for (const c of COLUMNS) mkdirSync(dir("board", c), { recursive: true });
  mkdirSync(dir("events"), { recursive: true });
  for (const name of ["master", "critic", "actor"]) {
    mkdirSync(join(dir("serfs"), name), { recursive: true });
  }
}

// ── THE ROLES: a classifier seat grades, the critic argues, the master decides ──
// GRADING IS A FUNCTION, NOT A PERSONA (the deer-flow correction): when the
// decisions port is configured it answers (graded, per-criterion — jev's
// implementation); when not, ONE cheap LLM call through the fixed template
// below, parsed by parseCriticVerdict. The seat has no serf folder and no
// identity — its track record persists in .bandit/grading/<card>.md for the
// refiner, calibration only. The critic is a full peer agent (consults);
// the master owns routing and the conversation.

// The classifier seat's prompt — a constant, not a template file. Grading is
// a function; functions don't have identities.
// The seat grades per acceptance criterion — a criterion answered in the
// consult thread is as real as one answered in the run output (the unfreeze:
// kiss-discipline.md, trigger MET 2026-09-28 — 3 grader/gate contradictions
// on one card). {{card.acceptance}} lists each criterion with an index;
// the reply must include a CRITERIA block scoring each one.
const GRADER_PROMPT = `Grade the work against EVERY acceptance criterion below, one line each.

TASK:
{{card.task}}

ACCEPTANCE CRITERIA:
{{card.acceptance}}

ACTOR OUTPUT:
{{actor.output}}
{{consultThread}}
Answer with ONLY:
CRITERIA: <one line per criterion, same order, format "- <index>: pass|fail|uncertain — <evidence>">
VERDICT: pass | fail | uncertain
CONFIDENCE: 0.0 to 1.0
REASONING: <the criterion lines that decided it>`;

function gradeDir(): string {
  const gd = join(dir("grading"));
  mkdirSync(gd, { recursive: true });
  return gd;
}

// ── EVENTS (append-only truth) ──

export function emit(type: string, payload: Record<string, unknown>): void {
  appendEvent(process.cwd(), type, payload);
}

export function readEvents(sinceTs?: string): LogEvent[] {
  return readKernelEvents(process.cwd(), sinceTs);
}

// ── BOARD (projection over card folders) ──

export function cardsIn(column: (typeof COLUMNS)[number]): CardFolder[] {
  return kernelCardsIn(process.cwd(), column);
}

// Hand intervention: put a card back in backlog from any column, on the record.
// The move is an event (by: "hand", with the reason), never a silent folder edit.
export function reopenCard(root: string, id: string, reason: string): void {
  if (!reason.trim()) throw new Error("--reason is required");
  const cardDir = findCardDir(root, id);
  if (!cardDir) throw new Error(`no card ${id} in any column`);
  if (!kernelMoveCard(root, id, parseCard(cardDir).column, "backlog")) throw new Error(`card ${id} moved while reopening — try again`);
  appendEvent(root, "card.moved", { card: id, to: "backlog", by: "hand", reason });
}

// Fenced exit from in-progress: only the process holding the latest claim
// moves the card, and only from in-progress. Anyone else abandons it in place.
export function exitInProgress(root: string, id: string, to: (typeof COLUMNS)[number]): boolean {
  const claim = latestClaim(root, id);
  const ok = claim !== null && sameClaimant(claim, self()) && kernelMoveCard(root, id, "in-progress", to);
  if (!ok) appendEvent(root, "card.claim_lost", { card: id, to, claimant: claim, self: self() });
  return ok;
}

// ── PIPELINES (difficulty-proportional) ──

export function pipelineFor(acceptanceCount: number, taskLength: number): "trivial" | "standard" | "hard" {
  let score = 0;
  if (acceptanceCount > 3) score += 2;
  if (taskLength > 200) score += 1;
  if (taskLength > 500) score += 2;
  return score <= 1 ? "trivial" : score <= 3 ? "standard" : "hard";
}

// ── CRITIC (folder serf: verdicts land in its outputs, plumbing retried on itself) ──

interface CriticVerdict {
  verdict: "pass" | "fail" | "uncertain";
  confidence: number;
  reasoning: string;
  plumbing: boolean;
}

export function parseCriticVerdict(text: string): CriticVerdict {
  const verdictMatch = text.match(/VERDICT:\s*(pass|fail|uncertain)/i);
  const confidenceMatch = text.match(/CONFIDENCE:\s*([\d.]+)/i);
  const reasoningMatch = text.match(/REASONING:\s*(.+)/i);
  // No parseable verdict = plumbing failure. Never fails the actor.
  if (!verdictMatch && !confidenceMatch && !reasoningMatch) {
    // The model has two masters: the serf prompt demands VERDICT:, but a
    // leaked global system prompt (e.g. PAI mode headers) makes it answer in
    // its own format. Detect that shape so the repair turn can say exactly
    // what was wrong instead of a generic "plumbing".
    const leakedFormat = /PAI \||NATIVE MODE|ALGORITHM MODE|MINIMAL\b/i.test(text);
    const reasoning = leakedFormat
      ? "critic answered in its harness's own format (global system prompt leaked into serf lane) — repair turn must restate: reply with ONLY the VERDICT:/CONFIDENCE:/REASONING: block"
      : "empty/unparseable critic response — plumbing, retry critic";
    return { verdict: "uncertain", confidence: 0, reasoning, plumbing: true };
  }
  return {
    verdict: (verdictMatch?.[1]?.toLowerCase() ?? "uncertain") as CriticVerdict["verdict"],
    confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0,
    reasoning: reasoningMatch?.[1]?.trim() ?? "",
    plumbing: !verdictMatch,
  };
}

// The classifier seat: no serf folder, no identity render — one cheap call
// from the fixed GRADER_PROMPT constant, parsed by parseCriticVerdict.
// Thread-visible (the 2026-09-28 unfreeze): the consult thread is in the
// prompt when it exists, so criteria satisfied in-thread are gradable — and
// the per-criterion CRITERIA lines are parsed alongside the verdict.
async function runCritic(cfg: LoopConfig, card: CardFolder, actorOutput: string, maxRepairTurns = 2, record = true): Promise<{ verdict: CriticVerdict; verdictPath: string | null; criteria: string | null }> {
  const { packObservation, runTransport } = await import("./runner");
  const packed = packObservation(actorOutput, card.dir, "actor-output");
  const threadPath = consultPath(card.dir);
  const thread = existsSync(threadPath) ? readConsultThread(card.dir).slice(0, 3000) : "";
  const threadBlock = thread ? "\nCONSULT THREAD (arguments and decisions so far — a criterion satisfied in-thread with evidence counts as satisfied):\n" + thread + "\n" : "";
  const prompt = GRADER_PROMPT
    .replace(/\{\{card\.task\}\}/g, card.body.slice(0, 2000))
    .replace(/\{\{card\.acceptance\}\}/g, (card.body.match(/## Acceptance\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "- verification command passes").slice(0, 1500))
    .replace(/\{\{actor\.output\}\}/g, packed.text.slice(0, packed.archived ? 6000 : 3000))
    .replace(/\{\{consultThread\}\}/g, threadBlock);

  let text = "";
  let verdict: CriticVerdict | null = null;
  let repairHint = "";

  // Repair loop: plumbing failures retry the SEAT, never the actor.
  for (let turn = 0; turn <= maxRepairTurns; turn++) {
    const out = join(gradeDir(), `${card.id}.seat-${Date.now().toString(36)}.md`);
    const run = await runTransport(cfg.transport, prompt + repairHint, card.dir, out, 300_000);
    text = run.output;
    verdict = parseCriticVerdict(text);
    if (!verdict.plumbing) break;
    // feed the specific failure back: "your last reply used the wrong format —
    // answer with ONLY the CRITERIA:/VERDICT:/CONFIDENCE:/REASONING: block"
    repairHint = `\n\nIMPORTANT — your previous reply was not parseable. ${verdict.reasoning} Reply with ONLY these lines and nothing else:\nCRITERIA: <one line per criterion>\nVERDICT: pass|fail|uncertain\nCONFIDENCE: 0.0-1.0\nREASONING: <evidence>`;
    emit("critic.repair", { card: card.id, turn });
  }

  const final = verdict ?? { verdict: "uncertain" as const, confidence: 0, reasoning: "grader plumbing after repairs", plumbing: true };
  // Track record: calibration data for the refiner — .bandit/grading/.
  // Per-criterion lines ride along: seat-vs-gate agreement becomes measurable
  // per criterion, which is the calibration loop's first data.
  const criteria = (text.match(/CRITERIA:[\s\S]*?(?=\nVERDICT:|$)/i)?.[0] ?? "").trim() || null;
  if (!record) return { verdict: final, verdictPath: null, criteria };
  const verdictPath = join(gradeDir(), `${card.id}.md`);
  writeFileSync(verdictPath, `VERDICT: ${final.verdict}\nCONFIDENCE: ${final.confidence}\nREASONING: ${final.reasoning}\n${criteria ?? ""}\n`);
  return { verdict: final, verdictPath, criteria };
}

// ── THE CONSULT THREAD (critic as the master's peer, present from problem-start) ──
// One per-card transcript (card/consult.md), threaded, plain text — the way
// the master↔addendum exchange actually worked. The master opens a consult at
// measured points (plan, stagnation, no-convergence); the critic argues as a
// peer; the master decides. Only the DECISION line is parseable — everything
// else is conversation. The thread never touches the verify gate: no consult
// turns a red gate green (the Goodhart boundary).

interface ConsultTurn {
  by: string; // "master" | "critic" | a summoned role's name
  text: string;
}

interface ConsultDecision {
  decision: "proceed" | "amend" | "reject" | "specialist" | "escalate" | null;
  capability: string | null; // specialist:<capability> payload
  summon: string | null;     // SUMMON: <role> — one domain voice into the thread
}

// One consult point per card, per trigger, by construction (convergeCard's
// consultedStagnation flag + the plan/route call sites). Bounds live in the
// callers, not in a counting scheme that can silently misread the transcript.
const CONSULT_MAX_POINTS = 3; // per card (plan, stagnation, no-convergence)

// Thread helpers: read the existing transcript, append a turn.
function consultPath(cardDir: string): string {
  return join(cardDir, "consult.md");
}

export function appendConsultTurn(cardDir: string, turn: ConsultTurn): void {
  const p = consultPath(cardDir);
  const header = existsSync(p) ? "" : "# Consult thread\n\n";
  writeFileSync(p, header + `**${turn.by}:**\n\n${turn.text.trim()}\n\n`, { flag: "a" });
}

export function readConsultThread(cardDir: string): string {
  const p = consultPath(cardDir);
  return existsSync(p) ? readFileSync(p, "utf-8").slice(-8000) : "";
}

function parseConsultDecision(text: string): ConsultDecision["decision"] {
  return text.match(/DECISION:\s*(proceed|amend|reject|specialist|escalate)/i)?.[1]?.toLowerCase() as ConsultDecision["decision"] ?? null;
}

// Routing fallback (Choice on the decision port): the DECISION line wins; when
// it is missing the port chooses over the five routes, and only a confident
// top label (p >= ROUTE_MIN_P) is taken. Anything else is escalate — the same
// path a missing line always took (no specialist, no requeue → review).
export const ROUTE_MIN_P = 0.5;
export const ROUTE_OPTIONS: Record<string, string> = {
  proceed: "the work can continue as it is; no change of plan is needed",
  amend: "retry the card with an amended plan that answers the arguments in the thread",
  reject: "the card or its plan is wrong and should not be retried as written",
  specialist: "the actor lacks a capability it cannot learn mid-card; spawn a specialist",
  escalate: "a human must decide; the agents cannot resolve this",
};

export async function routeDecision(
  port: DecisionPort | null,
  reply: string,
): Promise<{ decision: NonNullable<ConsultDecision["decision"]>; source: "line" | "choice" | "floor"; probabilities: Record<string, number> | null }> {
  const line = parseConsultDecision(reply);
  if (line) return { decision: line, source: "line", probabilities: null };
  const probabilities = port
    ? await port.choose(reply.slice(0, 6000), "Which route does this consult reply argue for?", ROUTE_OPTIONS).catch(() => null)
    : null;
  const top = probabilities ? Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] : undefined;
  if (top && top[1] >= ROUTE_MIN_P) {
    return { decision: top[0] as NonNullable<ConsultDecision["decision"]>, source: "choice", probabilities };
  }
  return { decision: "escalate", source: "floor", probabilities };
}

// SUMMON: <role> — the master's move inside a consult: bring ONE domain voice
// into the thread before deciding (researcher, architect, any role the project
// defines). The summoned serf is spawned as a real child folder (audit), runs
// one reply turn against the thread so far, and its argument joins consult.md
// — the compounding mechanism of the duck.ai thread, mechanically. The voice
// advises; it never touches the gate or grades anything.
export function parseSummon(text: string): string | null {
  return text.match(/SUMMON:\s*([A-Za-z][A-Za-z0-9 _-]{1,32})/i)?.[1]?.trim().split(/\s+/)[0] ?? null;
}

export async function summonConsultVoice(
  cfg: LoopConfig,
  cardDir: string,
  cardId: string,
  role: string,
  summoner: string,
  opening: string,
): Promise<{ reply: string | null }> {
  const roleDir = join(dir("serfs"), role);
  const promptPath = join(roleDir, "prompt.md");
  if (!existsSync(promptPath)) {
    emit("consult.summon_failed", { card: cardId, role, reason: "no such serf prompt" });
    return { reply: null };
  }
  // The spawn is the audit: a real child folder with origin + registry entry.
  const { registerChild } = await import("./bandit");
  const childName = role + "-consult-" + Date.now().toString(36).slice(-4);
  registerChild(cfg.root, summoner, childName, {
    spawnedBy: "summon:" + summoner,
    cardId,
    problem: "Summoned as consult voice: " + role,
    motivation: "consult thread " + cardId,
    createdAt: new Date().toISOString(),
  });
  emit("consult.summoned", { card: cardId, role, by: summoner, child: childName });
  const childDir = join(dir("serfs"), childName);
  mkdirSync(childDir, { recursive: true });
  writeFileSync(join(childDir, "prompt.md"), readFileSync(promptPath, "utf-8"));
  const voicePrompt =
    `SUMMONED VOICE — you are ${role}, summoned by the ${summoner} into a consult thread. ` +
    "You are an instrument, not a policy: answer as the domain expert. Cite sources; " +
    "mark claims you cannot verify as unverified. Your argument joins the thread the " +
    "master decides from — argue it well, then stand down.\n\n" + opening;
  const out = join(cardDir, "outputs", `consult-${Date.now().toString(36)}-${role}.md`);
  const reply = (await runSerfReply(cfg, childDir, out, voicePrompt)).output;
  appendConsultTurn(cardDir, { by: role, text: reply });
  emit("consult.turn", { card: cardId, by: role, bytes: reply.length });
  return { reply };
}

// One consult exchange: master opens with context, critic answers as a peer.
// The critic's reply is free text; the caller decides how to act on it.
async function consultCritic(
  cfg: LoopConfig,
  cardDir: string,
  cardId: string,
  opening: string,
): Promise<{ criticReply: string; turns: number }> {
  const criticDir = join(dir("serfs"), "critic");
  const outputsDir = join(cardDir, "outputs");
  mkdirSync(outputsDir, { recursive: true });
  // Master's opening turn is composed by the caller; recorded here.
  const masterPrompt =
    "CONSULT — you are the master's peer, present from the start of this problem. " +
    "Argue hard when you disagree; concede when answered. The master decides — " +
    "your job is that the decision is made with your best argument in the room.\n\n" +
    opening;
  const masterOut = join(outputsDir, `consult-${Date.now().toString(36)}-m.md`);
  const criticReply = (await runSerfReply(cfg, criticDir, masterOut, masterPrompt)).output;
  emit("consult.turn", { card: cardId, by: "critic", bytes: criticReply.length });
  return { criticReply, turns: 1 };
}

// A reply turn is a prompt→output exchange, not a full gated run: the gate is
// untouched by any consult (no conversation turns a red gate green), so the
// reply path skips gate/self-verify and lands its artifact in the card.
async function runSerfReply(cfg: LoopConfig, cwd: string, outputPath: string, prompt: string): Promise<{ output: string; tokensUsed: number }> {
  const { runTransport } = await import("./runner");
  const run = await runTransport(cfg.transport, prompt, cwd, outputPath, 300_000);
  return { output: run.output, tokensUsed: run.tokensUsed };
}

// ── PLAN-PHASE CONSULT (critic as peer at problem-start — replaces plan.rejected) ──
// The master shows the plan to the critic BEFORE execution tokens burn. The
// critic answers free text; the master decides. A rejected plan is now a
// conversation the master had, and the plan goes back amended — not just
// rejected. The DECISION line is the only parseable artifact.

async function consultOnPlan(cfg: LoopConfig, card: CardFolder, plan: string): Promise<{ proceed: boolean; feedback: string | null }> {
  const cardDir = findCardDir(cfg.root, card.id) ?? card.dir;
  emit("consult.opened", { card: card.id, thread: "plan" });
  // An amend-routed card re-enters with a prior thread — the critic's earlier
  // argument IS the plan feedback. Show it so the amended plan answers it
  // instead of repeating the same gap (the muky62ac lesson: amend routed, the
  // plan was regenerated identical, three rounds re-failed on the same wall).
  const priorThread = readConsultThread(cardDir);
  const opening =
    "## consult: plan — " + new Date().toISOString() + "\n\n" +
    "MASTER: The actor produced this plan. Argue it as a peer — what is wrong, what is missing, what will fail. " +
    "The master decides; end your reply with one line DECISION: proceed | amend | reject and your reasoning.\n\n" +
    (priorThread ? "PRIOR THREAD (a previous attempt was routed amend — the amended plan must answer these arguments):\n" + priorThread.slice(0, 3000) + "\n\n" : "") +
    "CARD:\n" + card.body.slice(0, 1200) + "\n\nPLAN:\n" + plan.slice(0, 5000);
  appendConsultTurn(cardDir, { by: "master", text: "The actor produced a plan for review. Argue it as a peer; end with DECISION: proceed | amend | reject.\n\nPLAN:\n" + plan.slice(0, 4000) });
  const { criticReply } = await consultCritic(cfg, cardDir, card.id, opening);
  appendConsultTurn(cardDir, { by: "critic", text: criticReply });
  // SUMMON: the master may bring one domain voice before deciding — the
  // compounding move (docs/plans/summoned-voices-plan.md). The summoned reply
  // joins the thread; the master (loop) still owns the final proceed/amend.
  const summon = parseSummon(criticReply);
  if (summon) {
    const { reply } = await summonConsultVoice(cfg, cardDir, card.id, summon, "critic", opening + "\n\nCRITIC'S ARGUMENT (why this voice is needed):\n" + criticReply.slice(0, 1500));
    if (reply) {
      // The voice's argument can change the decision only through the thread:
      // the critic re-weighs with the researcher's reply in the room. One
      // re-weigh turn, then the master decides on the whole thread.
      const reweighPrompt =
        "CONSULT (re-weigh) — the summoned voice has spoken. Re-read your decision " +
        "with its argument in the room; concede or hold. End with DECISION: proceed | amend | reject.\n\n" +
        "YOUR PRIOR DECISION:\n" + criticReply.slice(0, 1200) + "\n\nTHE SUMMONED VOICE:\n" + reply.slice(0, 3000);
      const reweigh = (await runSerfReply(cfg, join(dir("serfs"), "critic"), join(cardDir, "outputs", `consult-${Date.now().toString(36)}-reweigh.md`), reweighPrompt)).output;
      appendConsultTurn(cardDir, { by: "critic", text: reweigh });
      emit("consult.reweighed", { card: card.id, thread: "plan", after: summon });
      const final = parseConsultDecision(reweigh) ?? parseConsultDecision(criticReply);
      emit("consult.decided", { card: card.id, thread: "plan", decision: final, summoned: summon });
      if (final === "reject") return { proceed: false, feedback: reweigh };
      if (final === "amend") return { proceed: true, feedback: "CRITIC-CONSULT (plan — apply before executing):\n" + reweigh };
      return { proceed: true, feedback: null };
    }
  }
  const decision = parseConsultDecision(criticReply);
  emit("consult.decided", { card: card.id, thread: "plan", decision });
  if (decision === "reject") return { proceed: false, feedback: criticReply };
  if (decision === "amend") return { proceed: true, feedback: "CRITIC-CONSULT (plan — apply before executing):\n" + criticReply };
  return { proceed: true, feedback: null };
}

// ── STAGNATION CONSULT (same wall or different wall? — replaces the regex specialist trigger) ──
// Gate unchanged twice or the same missing capability cited twice: the master
// consults mid-flight. The specialist spawn becomes one possible outcome of
// the conversation, not a separate mechanism.

async function consultOnStagnation(
  cfg: LoopConfig,
  card: CardFolder,
  fingerprintRepeated: boolean,
  missingCapability: string | null,
  lastOutput: string,
): Promise<{ spawnCapability: string | null; feedback: string | null }> {
  const cardDir = findCardDir(cfg.root, card.id) ?? card.dir;
  emit("consult.opened", { card: card.id, thread: "stagnation" });
  const thread = readConsultThread(cardDir);
  const opening =
    "CONSULT (stagnation) — the card is stuck: " +
    (fingerprintRepeated ? "the verification gate returned the SAME failing output twice. " : "") +
    (missingCapability ? `The grader keeps citing the same missing capability: ${missingCapability}. ` : "") +
    "Same wall or different wall? If the actor lacks a capability it cannot learn mid-card, say specialist: <capability>. " +
    "If it is the same wall, say what unblocks it. End with one line DECISION: proceed | amend | specialist | escalate.\n\n" +
    (thread ? "THREAD SO FAR:\n" + thread.slice(0, 3000) + "\n\n" : "") +
    "CARD:\n" + card.body.slice(0, 1000) + "\n\nLAST OUTPUT:\n" + lastOutput.slice(0, 2500);
  appendConsultTurn(cardDir, { by: "master", text: "STAGNATION: " + (fingerprintRepeated ? "gate fingerprint repeated. " : "") + "missing capability cited twice: " + (missingCapability ?? "unknown") + ". Same wall or different wall? End with DECISION: proceed | amend | specialist | escalate." });
  const { criticReply } = await consultCritic(cfg, cardDir, card.id, opening);
  appendConsultTurn(cardDir, { by: "critic", text: criticReply });
  // SUMMON: on a persisted wall, the domain voice asks "wall or doorway?" —
  // a conversation instead of the regex counter's guess.
  const summon = parseSummon(criticReply);
  if (summon) {
    const { reply } = await summonConsultVoice(cfg, cardDir, card.id, summon, "critic", opening + "\n\nCRITIC'S ARGUMENT:\n" + criticReply.slice(0, 1200));
    if (reply) {
      const reweighPrompt =
        "CONSULT (re-weigh) — the summoned voice has spoken. Same wall or different wall, now with its argument in the room? " +
        "End with one line DECISION: proceed | amend | specialist | escalate.\n\n" +
        "YOUR PRIOR DECISION:\n" + criticReply.slice(0, 1200) + "\n\nTHE SUMMONED VOICE:\n" + reply.slice(0, 3000);
      const reweigh = (await runSerfReply(cfg, join(dir("serfs"), "critic"), join(cardDir, "outputs", `consult-${Date.now().toString(36)}-reweigh.md`), reweighPrompt)).output;
      appendConsultTurn(cardDir, { by: "critic", text: reweigh });
      emit("consult.reweighed", { card: card.id, thread: "stagnation", after: summon });
      const final = parseConsultDecision(reweigh) ?? parseConsultDecision(criticReply);
      const spawnCap2 = final === "specialist"
        ? (reweigh.match(/specialist:\s*([A-Za-z0-9 _-]{2,60})/i)?.[1]?.trim() ?? missingCapability)
        : null;
      emit("consult.decided", { card: card.id, thread: "stagnation", decision: final, capability: spawnCap2, summoned: summon });
      return { spawnCapability: spawnCap2, feedback: final === "amend" || final === "proceed" ? reweigh : null };
    }
  }
  const decision = parseConsultDecision(criticReply);
  const spawnCap = decision === "specialist"
    ? (criticReply.match(/specialist:\s*([A-Za-z0-9 _-]{2,60})/i)?.[1]?.trim() ?? missingCapability)
    : null;
  const feedback = decision === "amend" || decision === "proceed" ? criticReply : null;
  emit("consult.decided", { card: card.id, thread: "stagnation", decision, capability: spawnCap });
  return { spawnCapability: spawnCap, feedback };
}

// ── PLAN PHASE (non-trivial pipelines produce plan.md inside the card) ──

async function runPlanPhase(cfg: LoopConfig, card: CardFolder, actorDir: string): Promise<void> {
  emit("plan.started", { card: card.id });
  const currentDir = findCardDir(cfg.root, card.id) ?? card.dir;
  const run = await runSerfOnCard({
    serfDir: actorDir,
    cardDir: currentDir,
    root: cfg.root,
    workDir: cfg.workDir,
    transport: cfg.transport,
    vars: { planOnly: true },
  });
  // The plan is the run's output, persisted by the loop — not a var the
  // harness is told to write (vars can't express output paths; the placeholder
  // would ship literally to the model). Empty output = transport red, no plan.
  if (run.run.output.trim().length > 0) {
    writeFileSync(join(currentDir, "plan.md"), run.run.output);
  }
  emit("plan.finished", { card: card.id });
}

// ── DURABLE COUNTERS + BUDGET HARD STOP ──

// Card-level budget (durable, in frontmatter): once lifetime tokens exceed
// the limit, the card refuses further runs regardless of process restarts.
function budgetExhausted(card: CardFolder): boolean {
  const limit = parseInt(card.frontmatter.budgetLimit ?? "0", 10);
  if (!limit) return false;
  const used = parseInt(card.frontmatter.lifetimeTokensUsed ?? "0", 10);
  return used >= limit;
}

function recordSpend(card: CardFolder, tokens: number): void {
  const prior = parseInt(card.frontmatter.lifetimeTokensUsed ?? "0", 10);
  const updated = prior + tokens;
  const cardMd = join(card.dir, "card.md");
  const raw = readFileSync(cardMd, "utf-8");
  if (/lifetimeTokensUsed:/.test(raw)) {
    writeFileSync(cardMd, raw.replace(/lifetimeTokensUsed: \d+/, `lifetimeTokensUsed: ${updated}`));
  } else {
    writeFileSync(cardMd, raw.replace(/^---$/m, `---\nlifetimeTokensUsed: ${updated}`));
  }
}

// ── AMEND ROUTING (the loop re-opens its own review cards) ──
// A master "amend" route used to rot in review: the loop only drains
// in-progress + backlog, so the card waited for a human board move — the
// exact manual fix the dogfood card exists to eliminate. The repair: amend
// is a requeue, not a dead end. The card returns to backlog (the loop's own
// frontier re-drains it next pass, no human in the path), the round ledger
// travels in frontmatter, and reAmendCount bounds the cycle — two amend
// requeues and the card stays in review for a human (an amend loop is not
// convergence, it is a conversation pretending to converge).

export const AMEND_REQUEUE_LIMIT = 2;

export function amendRequeueCount(card: CardFolder): number {
  return parseInt(card.frontmatter.amendRequeues ?? "0", 10);
}

function recordAmendRequeue(card: CardFolder): void {
  const cardMd = join(card.dir, "card.md");
  const raw = readFileSync(cardMd, "utf-8");
  const next = amendRequeueCount(card) + 1;
  if (/amendRequeues:/.test(raw)) {
    writeFileSync(cardMd, raw.replace(/amendRequeues: \d+/, `amendRequeues: ${next}`));
  } else {
    writeFileSync(cardMd, raw.replace(/^---$/m, `---\namendRequeues: ${next}`));
  }
}

// ── CONVERGENCE ROUNDS ──
// Bounded actor-critic dialogue refereed by the lever. Each round: actor pull
// → verify gate → critic eval → ledger update. Round 0 = plan critique before
// any expensive attempt. Spawn a specialist serf when the same missing
// capability is cited in two consecutive round triages.

function leverOf(card: CardFolder): string | null {
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

async function convergeCard(
  config: LoopConfig,
  card: CardFolder,
  maxRetries: number,
  kind: "trivial" | "standard" | "hard",
): Promise<"converged" | "no-convergence" | "requeued"> {
  const conf = await import("./confidence");
  const actorDir = join(dir("serfs"), "actor");
  const leverId = leverOf(card);

  // Round 0: plan consult before expensive attempts (non-trivial pipelines).
  // The master shows the plan to the critic as a peer; the DECISION line
  // governs. Reject → back to the author with the critic's argument attached;
  // zero actor-execution tokens. Amend → the argument becomes plan feedback.
  if (kind !== "trivial") {
    await runPlanPhase(config, card, actorDir);
    const currentDir = findCardDir(config.root, card.id) ?? card.dir;
    const planPath = join(currentDir, "plan.md");
    if (existsSync(planPath)) {
      const plan = readFileSync(planPath, "utf-8");
      try {
        const consult = await consultOnPlan(config, parseCard(currentDir), plan);
        if (!consult.proceed) {
          emit("plan.rejected", { card: card.id, via: "consult", reasoning: (consult.feedback ?? "").slice(0, 100) });
          return "no-convergence"; // back to author, zero actor-execution tokens
        }
      } catch (e) {
        emit("consult.failed", { card: card.id, thread: "plan", reason: String(e).slice(0, 120) });
      }
    }
  }

  let lastFailedCapability: string | null = null;
  let consecutiveSameFailure = 0;
  let lastOutput = "";
  let consultedStagnation = false; // one stagnation consult per card
  // Online Context Compact (SoL-Pi): bounded per-round history for digests.
  let roundHistory: { round: number; green: boolean; verdict: string; confidence: number; reasoning: string; command?: string }[] = [];

  for (let round = 1; round <= maxRetries; round++) {
    emit("round.started", { card: card.id, round, lever: leverId });
    const currentCardDir = findCardDir(config.root, card.id) ?? card.dir;
    let feedback = round > 1
      ? "CONVERGENCE ROUND " + round + ". Previous rounds did not converge. Address the critic's issues with the lever in mind."
      : "";
    // ── Transport guard: 0-byte actor output is an immediate transport-red ──
    // (3rd {{actor.output}} failure mode, 2026-09-24: 90 empty run files).
    // An empty actor stdout means the transport failed — render a critic
    // prompt anyway and you burn critic rounds on a placeholder. Retry the
    // actor round up to 2× before surfacing transport.red; never feed the
    // critic an empty/placeholder input.
    let run: Awaited<ReturnType<typeof runSerfOnCard>>["run"];
    let gate: Awaited<ReturnType<typeof runSerfOnCard>>["gate"];
    let gateUnchanged = false;
    let selfVerify: Awaited<ReturnType<typeof runSerfOnCard>>["selfVerify"];
    let evidence: Awaited<ReturnType<typeof runSerfOnCard>>["evidence"];
    {
      let attempt = 0;
      let result: Awaited<ReturnType<typeof runSerfOnCard>> | null = null;
      while (attempt < 3) {
        result = await runSerfOnCard({
          serfDir: actorDir,
          cardDir: currentCardDir,
          root: config.root,
          workDir: config.workDir,
          transport: config.transport,
          container: config.container,
          reducer: config.reducer,
          vars: {
            feedback,
            lever: leverId ? "pull the lever — your work is measured by its instrument" : "",
          },
        });
        if (result.run.output.trim().length > 0) break;
        attempt += 1;
        emit("transport.empty_output", { card: card.id, round, attempt, bytes: result.run.output.length });
      }
      if (attempt > 0) emit("transport.retried", { card: card.id, round, emptyAttempts: attempt, recovered: result !== null && result.run.output.trim().length > 0 });
      ({ run, gate, selfVerify, evidence } = result!);
      gateUnchanged = result!.unchangedGate;
      if (run.output.trim().length === 0) {
        // transport red even after retries: skip the critic entirely, treat as red round
        emit("transport.red", { card: card.id, round, emptyAttempts: attempt + 1 });
        recordSpend(parseCard(currentCardDir), run.tokensUsed);
        if (leverId) conf.weaken(config.root, leverId, `round ${round}: transport red — empty actor output`);
        if (round >= maxRetries) {
          emit("task.failed", { card: card.id, reason: "transport-empty-output", attempts: round });
          return "no-convergence";
        }
        continue; // next round, fresh actor attempt
      }
    }
    if (selfVerify?.attempted && selfVerify.actualExitCode !== selfVerify.reportedExitCode) {
      emit("gate.selfverify", { card: card.id, round, reported: selfVerify.reportedExitCode, actual: selfVerify.actualExitCode });
    }
    if (evidence) {
      if (evidence.verified) {
        emit("gate.reduced", { card: card.id, round, from: evidence.sourceBytes, to: evidence.receiptBytes });
      } else if (evidence.reason && evidence.sourceBytes >= 4096) {
        emit("gate.reduce_failed", { card: card.id, round, reason: evidence.reason?.slice(0, 60) });
      }
    }
    lastOutput = run.output;
    recordSpend(parseCard(currentCardDir), run.tokensUsed);
    const green = gate.green;
    if (gate.reason === "unverifiable") {
      // fail-closed: actor-proposed command, no card verify, no container — never run on the host
      emit("verification.unverifiable", { card: card.id, round, reported: gate.reported });
    } else {
      emit(green ? "verification.green" : "verification.red", { card: card.id, round, command: gate.command, reported: gate.reported, selfVerified: selfVerify?.attempted ?? false, cardOwned: selfVerify?.cardOwned ?? false, actorExit: run.exitCode, actorStalled: run.stalled ?? false, actorBytes: run.output.length });
    }

    // ── Decision-port round gate (fail-closed: no evaluator → no questions) ──
    // The loop asks bandit's own questions through the DecisionPort; which
    // evaluator answers (Laya, Jev, future harness) is invisible here.
    if (decisionPort && gate.command && selfVerify?.outputPath && existsSync(selfVerify.outputPath)) {
      const verifLog = readFileSync(selfVerify.outputPath, "utf-8");
      const acceptance = (card.body.match(/## Acceptance\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "").slice(0, 2000);
      const answers = await askRoundGate(decisionPort, {
        demonstrates: acceptance,
        verificationOutput: verifLog.slice(0, 6000),
        verificationCommand: gate.command,
      });
      if (answers.demonstrates !== null || answers.vacuous !== null) {
        emit("decisions.gate", { card: card.id, round, demonstrates: answers.demonstrates, vacuous: answers.vacuous });
        if (answers.vacuous !== null && answers.vacuous > 0.7) emit("decisions.vacuous", { card: card.id, round, probability: answers.vacuous });
        if (answers.demonstrates !== null && answers.demonstrates < 0.3) emit("decisions.low_demonstrability", { card: card.id, round, probability: answers.demonstrates });
      }
    }

    // Critic evaluates (on green output) or TRIAGES (on red — cheap redirect).
    const { verdict, verdictPath, criteria } = await runCritic(config, parseCard(currentCardDir), lastOutput);
    emit("critic.verdict", { card: card.id, round, verdict: verdict.verdict, confidence: verdict.confidence, plumbing: verdict.plumbing, verdictPath, criteriaLines: criteria ? criteria.split("\n").filter((l) => /^\s*-\s/.test(l)).length : 0 });
    if (verdict.plumbing) {
      emit("critic.bypass", { card: card.id, round, reason: "plumbing-unparseable after repair" });
    }
    // Grader/gate contradiction: the seat passed while the gate was red.
    // Never blocks convergence (the gate is the truth), but the event log
    // records it — the seat's confidence is self-reported fiction until the
    // calibration loop exists, and this is the flag the refiner reads.
    if (!green && !verdict.plumbing && verdict.verdict === "pass") {
      emit("grader.gate_contradiction", { card: card.id, round, graderConfidence: verdict.confidence });
    }

    const converged = green && (verdict.plumbing || verdict.verdict !== "fail" || verdict.confidence <= 0.7);
    if (converged) {
      if (leverId) await conf.strengthen(config.root, leverId, 0.6, 2, "round " + round + ": converged with evidence");
      emit("converged", { card: card.id, round, ...(config.branch ? { branch: config.branch } : {}) });
      return "converged";
    }

    // Non-converged: triage via critic — extract the missing capability
    const triage = await runCritic(
      config,
      parseCard(currentCardDir),
      "TRIAGE: the actor's attempt did not pass. Answer: is this fixable by the actor (skill/execution), or is the card missing a prerequisite/external capability? Cite the specific missing artifact or capability.\n\nOUTPUT:\n" + lastOutput.slice(0, 2000),
      2,
      false,
    );
    const capabilityMatch = triage.verdict.reasoning.match(/missing[:\s]+([A-Za-z0-9 _-]{4,60})/i);
    const missingCapability = capabilityMatch?.[1]?.trim() ?? null;

    // Failure-similarity through the decision port (graded when an evaluator
    // is configured; regex-only when not).
    let similarity: number | null = null;
    if (decisionPort && round >= 2) {
      similarity = await decisionPort.failureSimilarity(
        (roundHistory[roundHistory.length - 1]?.reasoning ?? "").slice(0, 2000),
        verdict.reasoning.slice(0, 2000),
      );
      if (similarity !== null) emit("decisions.failure_similarity", { card: card.id, round, similarity });
    }
    if (similarity !== null) {
      // graded: ≥0.6 = same failure, ≤0.3 = different
      if (similarity >= 0.6 && missingCapability) consecutiveSameFailure += 1;
      else if (similarity <= 0.3) consecutiveSameFailure = 1;
    } else if (missingCapability && missingCapability === lastFailedCapability) {
      consecutiveSameFailure += 1;
    } else {
      consecutiveSameFailure = 1;
      lastFailedCapability = missingCapability;
    }

    // Stagnation consult: gate unchanged or the same failure cited twice —
    // the master talks to the critic mid-flight instead of firing the
    // specialist regex. The spawn becomes one possible outcome of the
    // conversation; the consult's verdict owns the signal.
    let consultSpawn: string | null = null;
    if (!consultedStagnation && round >= 2 && (gateUnchanged || consecutiveSameFailure >= 2)) {
      consultedStagnation = true;
      try {
        const stuck = await consultOnStagnation(config, parseCard(currentCardDir), gateUnchanged, missingCapability, lastOutput);
        if (stuck.spawnCapability) {
          consultSpawn = stuck.spawnCapability;
          lastFailedCapability = stuck.spawnCapability;
        }
        if (stuck.feedback) {
          feedback = "CRITIC-CONSULT (stagnation — the unblocking argument):\n" + stuck.feedback;
        }
      } catch (e) {
        emit("consult.failed", { card: card.id, thread: "stagnation", reason: String(e).slice(0, 120) });
      }
    }

    // Online Context Compact (SoL-Pi appropriation): later rounds get a
    // digest of prior rounds — verdicts, gate history, spend — not the full
    // transcript. Compaction happens exactly at a round boundary.
    if (round >= 2) {
      const digest = [
        `## Prior rounds (digest — details in card folder)`,
        ...roundHistory.map((h) => `- round ${h.round}: ${h.green ? "green" : "red"} gate (${h.command ?? "no cmd"}) · critic ${h.verdict}${h.confidence ? ` (${h.confidence})` : ""} — ${h.reasoning.slice(0, 90)}`),
      ].join("\n");
      roundHistory.push({ round, green, verdict: verdict.verdict, confidence: verdict.confidence, reasoning: verdict.reasoning, command: gate.command });
      roundHistory = roundHistory.slice(-4); // bounded — compaction, not accumulation
      feedback = (feedback ? feedback + "\n\n" : "") + digest;
    } else {
      roundHistory.push({ round, green, verdict: verdict.verdict, confidence: verdict.confidence, reasoning: verdict.reasoning, command: gate.command });
    }

    // Spawn trigger: the stagnation consult said specialist (its capability
    // payload), or — consult unavailable/plumbing — fall back to the regex
    // counter so stagnation never passes silently.
    const spawnCapability = consultSpawn ?? (consecutiveSameFailure >= 2 && !consultedStagnation ? missingCapability : null);
    if (spawnCapability) {
      const specialistName = "specialist-" + slugify(spawnCapability).slice(0, 24) + "-" + Date.now().toString(36).slice(-4);
      const { registerChild } = await import("./bandit");
      registerChild(config.root, "actor", "specialists/" + specialistName, {
        spawnedBy: "actor",
        cardId: card.id,
        problem: "Stuck on missing capability: " + spawnCapability,
        motivation: leverOf(card) ?? "convergence rounds",
        createdAt: new Date().toISOString(),
      });
      emit("specialist.spawned", { card: card.id, specialist: specialistName, capability: spawnCapability });
      consecutiveSameFailure = 0;
    }

    // Ledger: round pulled, needle flat
    if (leverId) conf.weaken(config.root, leverId, "round " + round + ": flat — " + triage.verdict.reasoning.slice(0, 60));
  }

  // No-convergence: the routing decision continues the SAME thread — the
  // master (not the critic) decides here, with the consult history in front
  // of it. One master turn; the DECISION line governs specialist spawning.
  // The card's folder may have been renamed since `card` was parsed — resolve
  // its current directory before touching it.
  try {
    const currentDir = findCardDir(config.root, card.id) ?? card.dir;
    const liveCard = parseCard(currentDir);
    const thread = readConsultThread(currentDir);
    const outputsDir = join(currentDir, "outputs");
    mkdirSync(outputsDir, { recursive: true });
    const masterOpening =
      "CONSULT (routing) — the card failed all convergence rounds. You have the thread below: " +
      "the critic's plan argument and, if it fired, the stagnation consult. Decide the route: " +
      "retry with an amended plan, spawn a specialist, or escalate to a human. " +
      "End with one line DECISION: proceed | amend | specialist | escalate. " +
      "If specialist, the SAME line must carry the capability: DECISION: specialist: <capability>.\n\n" +
      (thread ? "THREAD SO FAR:\n" + thread.slice(0, 4000) + "\n\n" : "") +
      "CARD:\n" + liveCard.body.slice(0, 1200) + "\n\nLAST GATE FAILURE:\n" + (lastFailedCapability ?? "none cited");
    appendConsultTurn(currentDir, { by: "master", text: "ROUTING: card failed " + maxRetries + " rounds. Decide: retry / specialist / escalate. End with DECISION line." });
    const masterOut = join(outputsDir, `consult-${Date.now().toString(36)}-route.md`);
    const masterReply = (await runSerfReply(config, join(dir("serfs"), "master"), masterOut, masterOpening)).output;
    appendConsultTurn(currentDir, { by: "master", text: masterReply });
    const { decision: route, source, probabilities } = await routeDecision(decisionPort, masterReply);
    emit("consult.decision", { card: card.id, thread: "route", decision: route, source, probabilities });
    emit("consult.routed", { card: card.id, decision: route });
    if (route === "specialist") {
      const capability = masterReply.match(/DECISION:\s*specialist:?\s*:?\s*([A-Za-z0-9 _-]{2,60})/i)?.[1]?.trim()
        ?? masterReply.match(/specialist:\s*([A-Za-z0-9 _-]{2,60})/i)?.[1]?.trim()
        ?? lastFailedCapability ?? "capability-unspecified";
      const specialistName = "specialist-" + slugify(capability).slice(0, 24) + "-" + Date.now().toString(36).slice(-4);
      const { registerChild } = await import("./bandit");
      registerChild(config.root, "actor", "specialists/" + specialistName, {
        spawnedBy: "master-consult",
        cardId: card.id,
        problem: "Master routed specialist after no-convergence: " + capability,
        motivation: leverOf(card) ?? "master consult",
        createdAt: new Date().toISOString(),
      });
      emit("specialist.spawned", { card: card.id, specialist: specialistName, capability, via: "master-consult" });
    } else if (route === "amend") {
      // Amend is a requeue, not a dead end (see AMEND ROUTING above).
      const requeuedDir = findCardDir(config.root, card.id) ?? card.dir;
      const requeuedCard = parseCard(requeuedDir);
      if (amendRequeueCount(requeuedCard) >= AMEND_REQUEUE_LIMIT) {
        emit("card.amend_limit", { card: card.id, requeues: amendRequeueCount(requeuedCard), limit: AMEND_REQUEUE_LIMIT });
      } else {
        recordAmendRequeue(requeuedCard); // runLoop makes the fenced move to backlog
        emit("card.requeued", { card: card.id, to: "backlog", reason: "master route: amend", requeues: amendRequeueCount(requeuedCard) });
        return "requeued";
      }
    }
  } catch (e) {
    emit("consult.failed", { card: card.id, thread: "route", reason: String(e).slice(0, 120) });
  }

  return "no-convergence";
}

// Rule 5: a failure writes the next card, unratified. The draft sits in
// .bandit/drafts/ (not a board column) with no `verify:` until a human
// writes and ratifies its check.
export function writeFailureDraft(root: string, cardId: string): string {
  const draftId = `${cardId}-retry`;
  const cardDir = findCardDir(root, cardId);
  const red = readKernelEvents(root).filter((e) => e.type === "verification.red" && e.card === cardId).pop();
  const cardVerify = cardDir ? parseCard(cardDir).frontmatter.verify : undefined;
  const command = String(red?.command || cardVerify || "(none)").replace(/\s+/g, " ").slice(0, 500);
  const logPath = cardDir ? join(cardDir, "verification-output.log") : "";
  const tail = logPath && existsSync(logPath) ? readFileSync(logPath, "utf-8").slice(-2000).replace(/```/g, "'''") : "";
  const md = [
    "---",
    `id: ${draftId}`,
    `title: retry ${cardId}: a smaller step`,
    "---",
    `# retry ${cardId}: a smaller step`,
    "",
    `Failed card: ${cardId}`,
    "",
    `Last gate: ${command}`,
    "",
    "```",
    tail,
    "```",
    "",
    "## Task",
    `Take one smaller step toward ${cardId}: make the first failing part of the gate above pass, and nothing else.`,
    "",
  ].join("\n");
  const dir = join(root, ".bandit", "drafts", draftId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "card.md");
  writeFileSync(path, md);
  appendEvent(root, "card.drafted", { card: cardId, draft: draftId, path });
  return path;
}

export async function runLoop(config: LoopConfig): Promise<{ processed: number; completed: number; failed: number }> {
  ensureScaffold();
  let processed = 0, completed = 0, failed = 0;
  const maxRetries = config.maxRetries ?? 3;

  // Decision port: resolved once per loop from config. null port when no
  // evaluator is configured — every question answered "no evaluator".
  const { loadDecisionConfig, resolveDecisionPort } = await import("./decisions");
  decisionPort = resolveDecisionPort(loadDecisionConfig(config.root));
  const isolated = isolationMode(config.root) === "worktree";

  // Frontier: in-progress cards whose latest claim is ours, then backlog cards
  // we win the claim on. An in-progress card held by a dead process (or by no
  // claim at all: boards from before claims) goes back to backlog first.
  const root = config.root;
  recoverPendingClaims(root);
  const mine: string[] = [];
  for (const c of kernelCardsIn(root, "in-progress")) {
    const claim = latestClaim(root, c.id);
    if (claim && sameClaimant(claim, self())) mine.push(c.id);
    else if (!claim || !claimantAlive(claim)) reclaimCard(root, c.id, claim);
  }
  const frontier = [...mine, ...kernelCardsIn(root, "backlog").map((c) => c.id)];
  for (const id of frontier) {
    const liveDir = findCardDir(root, id);
    const liveCard = liveDir ? readCard(liveDir) : null;
    if (!liveDir || !liveCard) continue; // moved under us: another loop's now
    if (budgetExhausted(liveCard)) {
      emit("card.budget_exhausted", { card: id });
      console.log(`  ⊘ ${id}: budget exhausted — skipping`);
      continue;
    }
    if (!mine.includes(id)) {
      if (!claimCard(root, id)) continue; // someone else won it
      emit("card.moved", { card: id, to: "in-progress" });
    }
    const card = parseCard(findCardDir(root, id) ?? liveDir);
    processed += 1;

    const kind = pipelineFor(card.body.match(/^- .+$/gm)?.length ?? 0, card.body.length);
    emit("pipeline.selected", { card: card.id, pipeline: kind });

    // Convergence rounds: bounded actor-critic dialogue refereed by the lever.
    // Each round: actor pulls → verify gate → critic evaluates → ledger update.
    // 3 rounds max; escalation to a spawned specialist on repeated same-
    // capability failure; final round failure → review (master escalation).
    // Isolation (opt-in): the rounds work in the card's own worktree; the card
    // folder stays on the board. Anything but converged leaves nothing behind.
    const wt = isolated ? openWorktree(config.root, card.id) : null;
    if (wt?.resetFrom) emit("isolation.branch_reset", { card: card.id, branch: wt.branch, previous: wt.resetFrom });
    let result: Awaited<ReturnType<typeof convergeCard>> | null = null;
    // Rule 1: nothing counts until the judge says so. In isolation mode the
    // kept branch is judged before the card may reach done; a red verdict
    // sends it to review and the branch stays as evidence.
    let verdict: string | undefined;
    let judgeFailure: Record<string, unknown> | null = null;
    try {
      result = await convergeCard(wt ? { ...config, workDir: wt.dir, branch: wt.branch } : config, card, maxRetries, kind);
    } finally {
      if (wt && result === "converged") {
        const kept = keepWorktree(config.root, card.id, `bandit: ${card.id} ${card.frontmatter.title ?? ""}`.trim());
        if (kept.error) {
          emit("isolation.commit_failed", { card: card.id, branch: kept.branch, dir: wt.dir, reason: kept.error });
          judgeFailure = { branch: kept.branch, error: "commit failed: nothing to judge" };
        } else {
          try {
            const v = await judge({ root, cardId: card.id, ref: kept.branch, base: wt.base });
            if (v.passed) {
              verdict = v.sha;
              try { readScore(root, root); } catch {} // recorded, never a gate
            }
            else judgeFailure = { branch: kept.branch, sha: v.sha, gates: v.gates.map((g) => ({ name: g.name, exitCode: g.exitCode, argv: g.argv })) };
          } catch (e) {
            judgeFailure = { branch: kept.branch, error: String(e instanceof Error ? e.message : e).slice(0, 200) };
          }
        }
      } else if (wt) {
        emit("isolation.discarded", { card: card.id, branch: discardWorktree(config.root, card.id) });
      }
    }
    if (result === "converged" && !wt) emit("judge.skipped", { card: card.id, reason: "shared mode" });
    if (result === "converged" && judgeFailure) {
      if (exitInProgress(root, card.id, "review")) {
        emit("task.failed", { card: card.id, reason: "judge", ...judgeFailure });
        writeFailureDraft(root, card.id);
        failed += 1;
      }
    } else if (result === "converged") {
      if (exitInProgress(root, card.id, "done")) {
        emit("card.completed", { card: card.id, ...(verdict ? { verdict } : {}) });
        completed += 1;
      }
    } else if (result === "requeued") {
      // The routing consult chose amend: back to backlog, the frontier of the
      // next pass. Not a failure; not a completion.
      exitInProgress(root, card.id, "backlog");
    } else if (exitInProgress(root, card.id, "review")) {
      emit("task.failed", { card: card.id, reason: "no-convergence", attempts: maxRetries });
      writeFailureDraft(root, card.id);
      failed += 1;
    }
  }

  // Refiner cadence: after the frontier drains, failure signatures trigger a pass.
  try {
    const { runRefinePass, shouldTrigger } = await import("./refiner");
    const trigger = shouldTrigger(config.root);
    if (trigger.trigger) {
      console.log(`  ⟳ refiner: ${trigger.reason}`);
      const result = await runRefinePass(config.root, async (prompt) => {
        const { runTransport } = await import("./runner");
        const run = await runTransport(config.transport, prompt, config.root, join(config.root, ".bandit", "refiner-last-llm.md"), 120_000);
        return run.output;
      });
      if (result.ran) console.log(`  ⟳ refiner pass: ${result.applied.length} applied, ${result.skipped.length} skipped (snapshot ${result.snapshot})`);
    }
  } catch {}

  // Persistent mode: when not --once, watch the board for new work instead of
  // exiting. fs.watch on backlog (event-driven — no polling). New cards or
  // review→backlog demotions wake the loop; each wake runs one full pass.
  if (!config.once) {
    const backlogDir = join(config.root, ".bandit", "board", "backlog");
    const inProgressDir = join(config.root, ".bandit", "board", "in-progress");
    console.log("  ◌ board drained — watching for new cards (event-driven, Ctrl+C to stop)\n");
    // visible liveness: one heartbeat per minute so holding never looks stuck
    const heartbeat = setInterval(() => {
      const t = new Date().toTimeString().slice(0, 8);
      console.log("  ◌ " + t + " watching… (board empty)");
    }, 60_000);
    let waking = false;
    const wake = async () => {
      if (kernelCardsIn(config.root, "backlog").length === 0 && kernelCardsIn(config.root, "in-progress").length === 0) return;
      waking = true;
      try {
        let pass;
        do {
          pass = await runLoop({ ...config, once: true });
        } while (pass.processed > 0 && kernelCardsIn(config.root, "backlog").length > 0); // a card arrived during the pass (budget-exhausted skips don't spin)
      } catch (e) {
        // a swallowed wake error looks exactly like "not working" — surface it
        console.log(`  ⚠ wake failed: ${String(e).slice(0, 120)}`);
      } finally {
        waking = false;
      }
    };
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const onBoardEvent = () => {
      if (waking) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { void wake(); }, 500);
    };
    for (const d of [backlogDir, inProgressDir]) {
      try {
        const { watch } = await import("node:fs");
        watch(d, { persistent: true }, onBoardEvent);
      } catch {}
    }
    // hold the loop open
    await new Promise<void>(() => {});
  }

  return { processed, completed, failed };
}