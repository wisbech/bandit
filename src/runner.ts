import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

// runner.ts — compose a bandit folder + a card into an execution.
// Each stage is a small function; no transport classes. ~150 lines.

export interface CardFolder {
  id: string;
  column: "backlog" | "in-progress" | "review" | "done";
  dir: string;
  frontmatter: Record<string, string>;
  body: string;
}

export interface SerfFolder {
  name: string;
  dir: string;
  prompt: string;
  identity: string;
  state: string;
}

export interface GateResult {
  green: boolean;
  command?: string;
  exitCode?: number;
  output?: string;
  inContainer: boolean;
  fingerprint?: string;
}

export interface RunResult {
  ok: boolean;
  output: string;
  tokensUsed: number;
}

// ── CARD PARSING (card-as-folder) ──

export function parseCard(dir: string): CardFolder {
  const raw = readFileSync(join(dir, "card.md"), "utf-8");
  const frontmatter: Record<string, string> = {};
  let body = raw;
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (fmMatch) {
    for (const line of fmMatch[1].split("\n")) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (m) frontmatter[m[1]] = m[2].trim();
    }
    body = raw.slice(fmMatch[0].length);
  }
  return {
    id: dir.split("/").pop()!,
    column: (frontmatter.column as CardFolder["column"]) ?? "backlog",
    dir,
    frontmatter,
    body,
  };
}

// Extract standard v2-style card sections from the body into template vars,
// so both card shapes work: frontmatter-based (bandit init) and section-based
// (migrated from v2: ## Task / ## Acceptance / ## Goal / ## Lever).
export function cardVars(card: CardFolder): Record<string, unknown> {
  const section = (name: string): string => {
    const m = card.body.match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`));
    return m ? m[1].trim() : "";
  };
  const acceptance = section("Acceptance")
    .split("\n")
    .map((l) => l.replace(/^-\s*/, "").trim())
    .filter(Boolean);
  return {
    ...card.frontmatter,
    task: card.frontmatter.task ?? (section("Task") || card.body.slice(0, 1500)),
    goal: card.frontmatter.goal ?? (section("Goal") || "complete the task"),
    acceptance: acceptance.length > 0 ? acceptance : ["verification command passes"],
    context: card.frontmatter.context ?? section("Context"),
    body: card.body,
  };
}

// Re-resolve a card's directory after a move: search the board for its id.
export function findCardDir(root: string, id: string): string | null {
  for (const col of ["backlog", "in-progress", "review", "done"]) {
    const candidate = join(root, ".bandit", "board", col, id);
    if (existsSync(join(candidate, "card.md"))) return candidate;
  }
  return null;
}

// ── SERF FOLDER READING ──

export function readSerfFolder(dir: string): SerfFolder {
  return {
    name: dir.split("/").pop()!,
    dir,
    prompt: readFileSync(join(dir, "prompt.md"), "utf-8"),
    identity: readFileSync(join(dir, "serf.md"), "utf-8"),
    state: existsSync(join(dir, "state.md")) ? readFileSync(join(dir, "state.md"), "utf-8") : "",
  };
}

// ── PROMPT RENDERING ──

export function renderPrompt(prompt: string, vars: Record<string, unknown>): string {
  return prompt.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (full, key: string) => {
    let cur: unknown = vars;
    for (const part of key.split(".")) {
      if (cur === null || cur === undefined) return full;
      cur = (cur as Record<string, unknown>)[part];
    }
    if (cur === null || cur === undefined) return full;
    if (Array.isArray(cur)) return cur.map((c) => `- ${c}`).join("\n");
    return String(cur);
  });
}

// ── TRANSPORT STAGE (headless: spawn CLI, wait for done marker) ──

export type Transport = "headless" | "uhp" | "herdr";

export interface TransportConfig {
  kind: Transport;
  command: string;   // e.g. "opencode"
  args: string[];    // e.g. ["run", "--model", "..."]
}

// Run one prompt through the transport. Writes output to the card folder.
export async function runTransport(cfg: TransportConfig, prompt: string, cwd: string, outputPath: string, timeoutMs: number): Promise<RunResult> {
  mkdirSync(cwd, { recursive: true });
  if (cfg.kind === "headless") {
    // v2's key insight: write output to a FILE and poll for growth, so a
    // stalled agent (0% CPU, empty output) is detectable and killable.
    // opencode streams to the file; we poll size every 10s.
    const stalled = (stallTurns: number, stallLimit: number) => stallTurns >= stallLimit;
    const stallLimit = 6; // 6 x 10s = 60s of zero growth = stuck
    const proc = Bun.spawn([cfg.command, ...cfg.args, prompt], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const startedAt = Date.now();
    const timer = setTimeout(() => proc.kill(), timeoutMs);

    // Poll for completion: process exit OR output-file stall (60s no growth
    // while process is at 0% CPU → kill; a working agent writes continuously).
    const result = await new Promise<{ stdout: string; exitCode: number; stalled: boolean }>((resolve) => {
      let done = false;
      let stallTurns = 0;
      let lastSize = -1;
      let lastCpu = -1;
      const finish = (stalled: boolean) => {
        if (done) return;
        done = true;
        clearInterval(interval);
        resolve({ stdout: "", exitCode: -1, stalled });
      };
      const interval = setInterval(() => {
        // liveness probe: process CPU. An agent that is thinking shows CPU;
        // a hung one sits at 0%.
        try {
          const cpuOut = Bun.spawnSync(["ps", "-o", "%cpu=", "-p", String(proc.pid)]).stdout.toString().trim();
          const cpu = parseFloat(cpuOut) || 0;
          // A TUI agent alternates: bursts of CPU while generating, idle
          // while streaming. Stall = 0% CPU for many consecutive checks.
          if (cpu < 1) stallTurns += 1; else stallTurns = 0;
          lastCpu = cpu;
        } catch { stallTurns += 1; }
        const elapsed = Date.now() - startedAt;
        if (elapsed > timeoutMs) { try { proc.kill(); } catch {} finish(true); }
        else if (stalled(stallTurns, stallLimit)) {
          console.log(`      ⊘ agent stalled (0% CPU × ${stallLimit} checks) — killing`);
          try { proc.kill(); } catch {}
          finish(true);
        }
      }, 10_000);
      proc.exited.then((code) => {
        clearInterval(interval);
        if (done) return;
        done = true;
        clearInterval(interval);
        resolve({ stdout: "", exitCode: code, stalled: false });
      });
    });

    // Drain stdout after exit/stall
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
    ]);
    clearTimeout(timer);
    writeFileSync(outputPath, stdout);
    return { ok: !result.stalled && result.exitCode === 0, output: stdout, tokensUsed: Math.ceil(stdout.length / 4) };
  }
  if (cfg.kind === "uhp") {
    // UHP: cfg.command = base url, cfg.args[0] = model, cfg.args[1] = api key (optional)
    const base = cfg.command.replace(/\/+$/, "");
    const model = cfg.args[0] ?? "default";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cfg.args[1]) headers["authorization"] = `Bearer ${cfg.args[1]}`;
    const response = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: prompt, model, stream: false, store: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return { ok: false, output: `UHP_ERROR: HTTP ${response.status} ${errText.slice(0, 200)}`, tokensUsed: 0 };
    }
    const json = (await response.json()) as {
      status: string;
      error: { message?: string } | null;
      output?: { type: string; content?: { type: string; text?: string }[] }[];
      usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number };
    };
    const text = (json.output ?? [])
      .filter((item) => item.type === "message")
      .flatMap((item) => (item.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? ""))
      .join("\n")
      .trim();
    writeFileSync(outputPath, text);
    const tokens = json.usage?.total_tokens ?? (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0);
    // incomplete = budget stop; cancelled/failed = not ok; incomplete is resumable-ok
    const ok = json.status === "completed" || (json.status === "incomplete" && text.length > 0);
    return { ok, output: text || `UHP_${json.status.toUpperCase()}`, tokensUsed: tokens };
  }
  if (cfg.kind === "herdr") {
    // Pane transport: the agent runs INTERACTIVELY in a visible herdr pane —
    // the primary human interface. Output is scraped from the pane's process
    // completion; prompt injected via the pane's shell.
    const herdr = await import("./herdr");
    if (!(await herdr.ping())) throw new Error("herdr not responding — run `herdr` in another terminal, or set transport=headless");
    const promptFile = join(cwd, ".bandit-prompt.md");
    writeFileSync(promptFile, prompt);
    const child = Bun.spawn([cfg.command, ...cfg.args, `Read ${promptFile} and follow those instructions exactly. Write your full report to ${outputPath}.`], {
      cwd, stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Promise<number>((resolve) => child.exited.then(resolve)),
    ]);
    clearTimeout(timer);
    writeFileSync(outputPath, stdout || (exitCode === 0 ? "" : ""));
    return { ok: exitCode === 0, output: stdout, tokensUsed: Math.ceil(stdout.length / 4) };
  }
  // herdr: wired later (pane management is optional substrate)
  throw new Error(`transport '${cfg.kind}' not wired yet`);
}

// ── GATE STAGE (verification + container + fingerprint) ──

export function parseGate(output: string): GateResult {
  const cmdMatch = output.match(/VERIFICATION_COMMAND:\s*(.+)/i);
  const exitMatch = output.match(/VERIFICATION_EXIT_CODE:\s*(\d+)/i);
  const outMatch = output.match(/VERIFICATION_OUTPUT:\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/i);
  const command = cmdMatch?.[1]?.trim();
  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : undefined;
  return {
    green: command !== undefined && exitCode === 0,
    command,
    exitCode,
    output: outMatch?.[1]?.trim(),
    inContainer: command ? command.includes("docker exec") : false,
    fingerprint: command ? fingerprint(command, outMatch?.[1] ?? "") : undefined,
  };
}

function fingerprint(command: string, output: string): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  let h = 5381;
  const s = `${norm(command)}::${norm(output.slice(0, 400))}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Load prior gate fingerprints from the card folder. Same fingerprint again =
// the gate failed identically before; the runner reports it so the prompt
// demands a change, not a re-run.
export function loadGateFingerprints(cardDir: string): string[] {
  const path = join(cardDir, "gates.json");
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as string[];
  } catch {
    return [];
  }
}

export function saveGateFingerprint(cardDir: string, fp: string): void {
  const path = join(cardDir, "gates.json");
  const prior = loadGateFingerprints(cardDir);
  if (!prior.includes(fp)) prior.push(fp);
  writeFileSync(path, JSON.stringify(prior, null, 2));
}

// Compose the container stage: wrap a command for docker exec when declared.
export function containerStage(command: string, container?: string): string {
  if (!container) return command;
  if (command.includes(`docker exec ${container}`)) return command;
  return `docker exec ${container} sh -c '${command.replace(/'/g, "'\\''")}'`;
}

// ── THE COMPOSED RUNNER ──

export interface RunOptions {
  serfDir: string;
  cardDir: string;
  transport: TransportConfig;
  container?: string;
  vars: Record<string, unknown>;
  timeoutMs?: number;
}

// One complete execution: render prompt from bandit folder, run transport,
// evaluate the gate, persist output + gate fingerprint into the card folder.
export async function runSerfOnCard(opts: RunOptions): Promise<{ run: RunResult; gate: GateResult; unchangedGate: boolean }> {
  const serf = readSerfFolder(opts.serfDir);
  const card = parseCard(opts.cardDir);
  const prompt = renderPrompt(serf.prompt, { ...opts.vars, serf: { name: serf.name }, card: cardVars(card) });

  const outputsDir = join(opts.cardDir, "outputs");
  mkdirSync(outputsDir, { recursive: true });
  const outputPath = join(outputsDir, `run-${Date.now().toString(36)}.md`);

  const run = await runTransport(opts.transport, prompt, opts.cardDir, outputPath, opts.timeoutMs ?? 600_000);
  let gate = parseGate(run.output);

  // container stage
  if (opts.container && gate.command) {
    gate.inContainer = gate.command.includes(`docker exec ${opts.container}`);
  }

  // gate fingerprint stage
  let unchangedGate = false;
  if (!gate.green && gate.fingerprint) {
    unchangedGate = loadGateFingerprints(opts.cardDir).includes(gate.fingerprint);
    saveGateFingerprint(opts.cardDir, gate.fingerprint);
  }

  return { run, gate, unchangedGate };
}