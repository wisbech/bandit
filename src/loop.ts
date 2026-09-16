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

    let green = false;
    let lastOutput = "";
    for (let attempt = 1; attempt <= maxRetries && !green; attempt++) {
      emit("attempt.started", { card: card.id, attempt });
      const actorDir = join(dir("serfs"), "actor");
      // the card moved to in-progress before this run — re-resolve its dir
      const currentCardDir = findCardDir(config.root, card.id) ?? card.dir;
      const { run, gate, unchangedGate } = await runSerfOnCard({
        serfDir: actorDir,
        cardDir: currentCardDir,
        transport: config.transport,
        container: config.container,
        vars: { feedback: attempt > 1 ? "Previous attempt failed verification. Change something." : "" },
      });
      lastOutput = run.output;
      recordSpend(parseCard(findCardDir(config.root, card.id) ?? card.dir), run.tokensUsed);
      green = gate.green;
      emit(green ? "verification.green" : "verification.red", { card: card.id, attempt, command: gate.command, unchangedGate });
    }

    // Critic gate: on green verification the critic judges; plumbing failures
    // after repair = bypass with documentation (never fail the actor).
    if (green) {
      const { verdict, verdictPath } = await runCritic(config, parseCard(findCardDir(config.root, card.id) ?? card.dir), lastOutput);
      emit("critic.verdict", { card: card.id, verdict: verdict.verdict, confidence: verdict.confidence, plumbing: verdict.plumbing, verdictPath });
      if (verdict.plumbing) {
        emit("critic.bypass", { card: card.id, reason: "plumbing-unparseable after repair" });
      } else if (verdict.verdict === "fail" && verdict.confidence > 0.7) {
        green = false;
      }
    }

    if (green) {
      moveCard(card, "done");
      emit("card.completed", { card: card.id });
      completed += 1;
    } else {
      moveCard(card, "review");
      emit("task.failed", { card: card.id, reason: "max-retries", attempts: maxRetries });
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