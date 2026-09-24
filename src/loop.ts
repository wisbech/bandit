import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parseCard, findCardDir, runSerfOnCard, parseGate, type TransportConfig, type CardFolder } from "./runner";
import { askRoundGate, type DecisionPort } from "./decisions";

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
  readOnly?: boolean;         // visitor: watch + heartbeat, never process cards
  reducer?: { command: string; args: string[] }; // Evidence-Preserving Reducer (cheap model)
}

const COLUMNS = ["backlog", "in-progress", "review", "done"] as const;

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

// ── EVENTS (append-only truth) ──

export function emit(type: string, payload: Record<string, unknown>): void {
  const date = new Date().toISOString().slice(0, 10);
  const file = join(dir("events"), `${date}.jsonl`);
  writeFileSync(file, JSON.stringify({ type, ts: new Date().toISOString(), ...payload }) + "\n", { flag: "a" });
}

export function readEvents(sinceTs?: string): { type: string; ts: string; [k: string]: unknown }[] {
  const eventsDir = dir("events");
  if (!existsSync(eventsDir)) return [];
  const out: { type: string; ts: string; [k: string]: unknown }[] = [];
  for (const f of readdirSync(eventsDir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(eventsDir, f), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!sinceTs || e.ts > sinceTs) out.push(e);
      } catch {}
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

// ── BOARD (projection over card folders) ──

export function cardsIn(column: (typeof COLUMNS)[number]): CardFolder[] {
  const colDir = dir("board", column);
  if (!existsSync(colDir)) return [];
  return readdirSync(colDir)
    .map((name) => join(colDir, name))
    .filter((d) => existsSync(join(d, "card.md")))
    .map((d) => parseCard(d));
}

export function moveCard(card: CardFolder, to: (typeof COLUMNS)[number]): void {
  // The card may have been moved since it was read — resolve its current dir.
  const current = findCardDir(configRoot(), card.id) ?? card.dir;
  const target = dir("board", to, card.id);
  renameSync(current, target);
  const cardMd = join(target, "card.md");
  const raw = readFileSync(cardMd, "utf-8").replace(/^column: .+$/m, `column: ${to}`);
  writeFileSync(cardMd, raw);
}

// The loop's config root, set once per runLoop call (module-level because
// moveCard is a projection helper).
let _root: string | null = null;
function configRoot(): string {
  return _root ?? process.cwd();
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
    return { verdict: "uncertain", confidence: 0, reasoning: "empty/unparseable critic response — plumbing, retry critic", plumbing: true };
  }
  return {
    verdict: (verdictMatch?.[1]?.toLowerCase() ?? "uncertain") as CriticVerdict["verdict"],
    confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0,
    reasoning: reasoningMatch?.[1]?.trim() ?? "",
    plumbing: !verdictMatch,
  };
}

// ObservationPack (SoL-Pi appropriation): big actor outputs become a stable
// on-disk handle + bounded excerpt — exact content stays retrievable on
// demand, we just stop inlining 50KB into the critic prompt.
async function runCritic(cfg: LoopConfig, card: CardFolder, actorOutput: string, maxRepairTurns = 2): Promise<{ verdict: CriticVerdict; verdictPath: string | null }> {
  const criticDir = join(dir("serfs"), "critic");
  const { packObservation } = await import("./runner");
  const packed = packObservation(actorOutput, card.dir, "actor-output");
  const prompt = readFileSync(join(criticDir, "prompt.md"), "utf-8")
    .replace(/\{\{card\.task\}\}/g, card.body.slice(0, 2000))
    .replace(/\{\{actor\.output\}\}/g, packed.text.slice(0, packed.archived ? 6000 : 3000));

  let text = "";
  let verdict: CriticVerdict | null = null;

  // Repair loop: plumbing failures retry the CRITIC, never the actor.
  for (let turn = 0; turn <= maxRepairTurns; turn++) {
    const run = await runSerfOnCard({
      serfDir: criticDir,
      cardDir: card.dir,
      transport: cfg.transport,
      vars: { "actor.output": packed.text },
    });
    text = run.run.output;
    verdict = parseCriticVerdict(text);
    if (!verdict.plumbing) break;
    emit("critic.repair", { card: card.id, turn });
  }

  const final = verdict ?? { verdict: "uncertain" as const, confidence: 0, reasoning: "critic plumbing after repairs", plumbing: true };
  // Persist the verdict into the critic's folder (its track record).
  const verdictsDir = join(criticDir, "outputs");
  mkdirSync(verdictsDir, { recursive: true });
  const verdictPath = join(verdictsDir, `${card.id}.md`);
  writeFileSync(verdictPath, `VERDICT: ${final.verdict}\nCONFIDENCE: ${final.confidence}\nREASONING: ${final.reasoning}\n`);
  return { verdict: final, verdictPath };
}

// ── PLAN PHASE (non-trivial pipelines produce plan.md inside the card) ──

async function runPlanPhase(cfg: LoopConfig, card: CardFolder, actorDir: string): Promise<void> {
  emit("plan.started", { card: card.id });
  const currentDir = findCardDir(cfg.root, card.id) ?? card.dir;
  await runSerfOnCard({
    serfDir: actorDir,
    cardDir: currentDir,
    transport: cfg.transport,
    vars: { planOnly: true, output: { path: join(currentDir, "plan.md") } },
    // The actor's prompt template handles plan-only mode via the same runner;
    // the output file is the plan.
  });
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

// ── EVENT-SOURCED REPLAY REPAIR (rebuild the board projection from events) ──

export function repairBoardFromEvents(): { moved: number; repaired: string[] } {
  const events = readEvents();
  const moved: string[] = [];
  const repaired: string[] = [];
  // Latest card.moved event per card wins.
  const latest = new Map<string, { to: string; ts: string }>();
  for (const e of events) {
    if (e.type === "card.moved" || e.type === "card.completed" || e.type === "task.failed") {
      const cardId = String((e as Record<string, unknown>).card ?? (e as Record<string, unknown>).payload);
      const to = e.type === "card.completed" ? "done" : e.type === "task.failed" ? "review" : String((e as Record<string, unknown>).to ?? "");
      if (cardId && to) latest.set(cardId, { to, ts: String(e.ts) });
    }
  }
  for (const [cardId, { to }] of latest) {
    for (const col of COLUMNS) {
      if (col === to) continue;
      const candidate = dir("board", col, cardId);
      if (existsSync(join(candidate, "card.md"))) {
        renameSync(candidate, dir("board", to, cardId));
        moved.push(`${cardId}: ${col} → ${to}`);
      }
    }
    if (existsSync(join(dir("board", to, cardId), "card.md"))) repaired.push(cardId);
  }
  return { moved: moved.length, repaired };
}

// ── CONVERGENCE ROUNDS ──
// Bounded actor-critic dialogue refereed by the lever. Each round: actor pull
// → verify gate → critic eval → ledger update. Round 0 = plan critique before
// any expensive attempt. Spawn a specialist serf when the same missing
// capability is cited in two consecutive round triages.

function leverOf(card: CardFolder): string | null {
  const m = card.body.match(/## Lever\n([\s\S]*?)(?=\n## |$)/m);
  const lever = m?.[1]?.trim();
  return lever ? `lever:${card.id}` : null;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function convergeCard(
  config: LoopConfig,
  card: CardFolder,
  maxRetries: number,
  kind: "trivial" | "standard" | "hard",
): Promise<"converged" | "no-convergence"> {
  const conf = await import("./confidence");
  const actorDir = join(dir("serfs"), "actor");
  const leverId = leverOf(card);

  // Round 0: plan critique before expensive attempts (non-trivial pipelines).
  if (kind !== "trivial") {
    await runPlanPhase(config, card, actorDir);
    const currentDir = findCardDir(config.root, card.id) ?? card.dir;
    const planPath = join(currentDir, "plan.md");
    if (existsSync(planPath)) {
      const plan = readFileSync(planPath, "utf-8");
      const { verdict } = await runCritic(config, parseCard(currentDir), plan);
      if (verdict.plumbing) {
        emit("critic.bypass", { card: card.id, reason: "plan-critique plumbing" });
      } else if (verdict.verdict === "fail" && verdict.confidence > 0.7) {
        emit("plan.rejected", { card: card.id, reasoning: verdict.reasoning.slice(0, 100) });
        return "no-convergence"; // back to author, zero actor-execution tokens
      }
    }
  }

  let lastFailedCapability: string | null = null;
  let consecutiveSameFailure = 0;
  let lastOutput = "";
  // Online Context Compact (SoL-Pi): bounded per-round history for digests.
  let roundHistory: { round: number; green: boolean; verdict: string; confidence: number; reasoning: string; command?: string }[] = [];

  for (let round = 1; round <= maxRetries; round++) {
    emit("round.started", { card: card.id, round, lever: leverId });
    const currentCardDir = findCardDir(config.root, card.id) ?? card.dir;
    let feedback = round > 1
      ? "CONVERGENCE ROUND " + round + ". Previous rounds did not converge. Address the critic's issues with the lever in mind."
      : "";
    const specialistDir = consecutiveSameFailure >= 2 ? lastFailedCapability : null;
    void specialistDir;
    const { run, gate, selfVerify, evidence } = await runSerfOnCard({
      serfDir: actorDir,
      cardDir: currentCardDir,
      transport: config.transport,
      container: config.container,
      reducer: config.reducer,
      vars: {
        feedback,
        lever: leverId ? "pull the lever — your work is measured by its instrument" : "",
      },
    });
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
    emit(green ? "verification.green" : "verification.red", { card: card.id, round, command: gate.command, selfVerified: selfVerify?.attempted ?? false });

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
    const { verdict, verdictPath } = await runCritic(config, parseCard(currentCardDir), lastOutput);
    emit("critic.verdict", { card: card.id, round, verdict: verdict.verdict, confidence: verdict.confidence, plumbing: verdict.plumbing, verdictPath });
    if (verdict.plumbing) {
      emit("critic.bypass", { card: card.id, round, reason: "plumbing-unparseable after repair" });
    }

    const converged = green && (verdict.plumbing || verdict.verdict !== "fail" || verdict.confidence <= 0.7);
    if (converged) {
      if (leverId) await conf.strengthen(config.root, leverId, 0.6, 2, "round " + round + ": converged with evidence");
      emit("converged", { card: card.id, round });
      return "converged";
    }

    // Non-converged: triage via critic — extract the missing capability
    const triage = await runCritic(
      config,
      parseCard(currentCardDir),
      "TRIAGE: the actor's attempt did not pass. Answer: is this fixable by the actor (skill/execution), or is the card missing a prerequisite/external capability? Cite the specific missing artifact or capability.\n\nOUTPUT:\n" + lastOutput.slice(0, 2000),
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

    // Spawn trigger: same missing capability twice → spawn a specialist child
    if (consecutiveSameFailure >= 2 && missingCapability) {
      const specialistName = "specialist-" + slugify(missingCapability).slice(0, 24) + "-" + Date.now().toString(36).slice(-4);
      const { registerChild } = await import("./bandit");
      registerChild(config.root, "actor", "specialists/" + specialistName, {
        spawnedBy: "actor",
        cardId: card.id,
        problem: "Two rounds failed on missing capability: " + missingCapability,
        motivation: leverOf(card) ?? "convergence rounds",
        createdAt: new Date().toISOString(),
      });
      emit("specialist.spawned", { card: card.id, specialist: specialistName, capability: missingCapability });
      consecutiveSameFailure = 0;
    }

    // Ledger: round pulled, needle flat
    if (leverId) conf.weaken(config.root, leverId, "round " + round + ": flat — " + triage.verdict.reasoning.slice(0, 60));
  }

  return "no-convergence";
}

export async function runLoop(config: LoopConfig): Promise<{ processed: number; completed: number; failed: number }> {
  _root = config.root;
  ensureScaffold();
  let processed = 0, completed = 0, failed = 0;
  const maxRetries = config.maxRetries ?? 3;

  // Decision port: resolved once per loop from config. null port when no
  // evaluator is configured — every question answered "no evaluator".
  const { loadDecisionConfig, resolveDecisionPort } = await import("./decisions");
  decisionPort = resolveDecisionPort(loadDecisionConfig(config.root));

  // Resume stranded in-progress cards (from interrupted runs) + fresh backlog.
  const frontier = [...cardsIn("in-progress"), ...cardsIn("backlog")];
  for (const card of frontier) {
    const liveCard = parseCard(findCardDir(config.root, card.id) ?? card.dir);
    if (budgetExhausted(liveCard)) {
      emit("card.budget_exhausted", { card: card.id });
      console.log(`  ⊘ ${card.id}: budget exhausted — skipping`);
      continue;
    }
    if (liveCard.column !== "in-progress") {
      moveCard(liveCard, "in-progress");
      emit("card.moved", { card: card.id, to: "in-progress" });
    }
    processed += 1;

    const kind = pipelineFor(card.body.match(/^- .+$/gm)?.length ?? 0, card.body.length);
    emit("pipeline.selected", { card: card.id, pipeline: kind });

    // trivial pipelines skip the plan phase
    const needsPlan = kind !== "trivial";
    if (needsPlan) {
      await runPlanPhase(config, card, join(dir("serfs"), "actor"));
    }

    // Convergence rounds: bounded actor-critic dialogue refereed by the lever.
    // Each round: actor pulls → verify gate → critic evaluates → ledger update.
    // 3 rounds max; escalation to a spawned specialist on repeated same-
    // capability failure; final round failure → review (master escalation).
    const result = await convergeCard(config, card, maxRetries, kind);
    processed += 0; // counted above
    if (result === "converged") {
      moveCard(card, "done");
      emit("card.completed", { card: card.id });
      completed += 1;
    } else {
      moveCard(card, "review");
      emit("task.failed", { card: card.id, reason: "no-convergence", attempts: maxRetries });
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
      if (config.readOnly) return; // visitors observe; the lock holder processes
      if (cardsIn("backlog").length === 0 && cardsIn("in-progress").length === 0) return;
      try {
        await runLoop({ ...config, once: true });
      } catch (e) {
        // a swallowed wake error looks exactly like "not working" — surface it
        console.log(`  ⚠ wake failed: ${String(e).slice(0, 120)}`);
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