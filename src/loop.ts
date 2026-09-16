import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parseCard, findCardDir, runSerfOnCard, parseGate, type TransportConfig, type CardFolder } from "./runner";

// loop.ts — the only imperative code in bandit.
// Poll board → pick frontier card → run pipeline → emit events → refiner check.

export interface LoopConfig {
  root: string;               // project root (contains .bandit/)
  transport: TransportConfig;
  container?: string;
  maxRetries?: number;
  once?: boolean;
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

async function runCritic(cfg: LoopConfig, card: CardFolder, actorOutput: string, maxRepairTurns = 2): Promise<{ verdict: CriticVerdict; verdictPath: string | null }> {
  const criticDir = join(dir("serfs"), "critic");
  const prompt = readFileSync(join(criticDir, "prompt.md"), "utf-8")
    .replace(/\{\{card\.task\}\}/g, card.body.slice(0, 2000))
    .replace(/\{\{actor\.output\}\}/g, actorOutput.slice(0, 3000));

  let text = "";
  let verdict: CriticVerdict | null = null;

  // Repair loop: plumbing failures retry the CRITIC, never the actor.
  for (let turn = 0; turn <= maxRepairTurns; turn++) {
    const run = await runSerfOnCard({
      serfDir: criticDir,
      cardDir: card.dir,
      transport: cfg.transport,
      vars: { "actor.output": actorOutput },
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

  for (let round = 1; round <= maxRetries; round++) {
    emit("round.started", { card: card.id, round, lever: leverId });
    const currentCardDir = findCardDir(config.root, card.id) ?? card.dir;
    const feedback = round > 1
      ? "CONVERGENCE ROUND " + round + ". Previous rounds did not converge. Address the critic's issues with the lever in mind."
      : "";
    const specialistDir = consecutiveSameFailure >= 2 ? lastFailedCapability : null;
    void specialistDir;
    const { run, gate } = await runSerfOnCard({
      serfDir: actorDir,
      cardDir: currentCardDir,
      transport: config.transport,
      container: config.container,
      vars: {
        feedback,
        lever: leverId ? "pull the lever — your work is measured by its instrument" : "",
      },
    });
    lastOutput = run.output;
    recordSpend(parseCard(currentCardDir), run.tokensUsed);
    const green = gate.green;
    emit(green ? "verification.green" : "verification.red", { card: card.id, round, command: gate.command });

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
    if (missingCapability && missingCapability === lastFailedCapability) {
      consecutiveSameFailure += 1;
    } else {
      consecutiveSameFailure = 1;
      lastFailedCapability = missingCapability;
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
      if (cardsIn("backlog").length === 0 && cardsIn("in-progress").length === 0) return;
      try {
        await runLoop({ ...config, once: true });
      } catch {}
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