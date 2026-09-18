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

export type Transport = "headless" | "uhp" | "herdr" | "acp";

export interface TransportConfig {
  kind: Transport;
  command: string;   // e.g. "opencode"
  args: string[];    // e.g. ["run", "--model", "..."]
  env?: Record<string, string>;      // extra env for the agent process
  timeoutMs?: number;                // per-run override
  capabilities?: HarnessCapabilities; // what this harness advertises
  model?: string;                    // ACP: session model preference ("provider/id" or bare id)
  gateway?: { baseUrl: string; headers: Record<string, string> }; // ACP client-managed LLM routing
}

// Capability flags — never invent a control the harness didn't advertise
// (protocol.md rule 4). Parsed from the adapter's own declarations.
export interface HarnessCapabilities {
  streaming?: boolean;
  cancel?: boolean;
  sessions?: boolean;
  models?: boolean;
}

// A harness adapter profile: one declarative file in .bandit/harnesses/.
// The factory owns identity + state; the harness owns its native session.
export interface HarnessProfile {
  name: string;
  command: string;
  args: string[];
  protocol: Transport;
  capabilities?: HarnessCapabilities;
  env?: Record<string, string>;
  model?: string;   // ACP session model preference
  gateway?: { baseUrl: string; headers: Record<string, string> }; // ACP client-managed LLM routing
}

export function loadHarnessProfiles(root: string): Map<string, HarnessProfile> {
  const profiles = new Map<string, HarnessProfile>();
  const dir = join(root, ".bandit", "harnesses");
  if (!existsSync(dir)) return profiles;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const p = JSON.parse(readFileSync(join(dir, f), "utf-8")) as HarnessProfile;
      if (p?.name && p?.command && p?.protocol) profiles.set(p.name, p);
    } catch {}
  }
  return profiles;
}

export function resolveTransport(cfg: TransportConfig, root: string): TransportConfig {
  // A named profile takes precedence when transport.kind points at one.
  const profiles = loadHarnessProfiles(root);
  const profile = profiles.get(cfg.kind as string);
  if (profile) {
    const args = cfg.args ?? [];
    const mi = args.indexOf("--model");
    return {
      kind: profile.protocol,
      command: profile.command,
      args: profile.args ?? [],
      env: profile.env,
      capabilities: profile.capabilities,
      model: profile.model ?? cfg.model ?? (mi >= 0 ? args[mi + 1] : undefined),
      gateway: profile.gateway,
      timeoutMs: cfg.timeoutMs,
    };
  }
  return cfg;
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
  if (cfg.kind === "acp") {
    // ACP (Agent Client Protocol) — JSON-RPC over stdio. The universal spoke:
    // Claude Code, Codex, OMP, PI all speak it via adapters, and harness-remote
    // exposes the same shape remotely. One implementation, many harnesses.
    const text = await acpPrompt(cfg, prompt, cwd, timeoutMs);
    writeFileSync(outputPath, text);
    return { ok: text.length > 0, output: text, tokensUsed: Math.ceil(text.length / 4) };
  }
  // herdr: wired later (pane management is optional substrate)
  throw new Error(`transport '${cfg.kind}' not wired yet`);
}

// ── ACP CLIENT (minimal: initialize → new_session → prompt → collect) ──
// Lifecycle per agentclientprotocol.com v1: initialize negotiates capabilities,
// session/new binds cwd, session/prompt runs one turn to a StopReason.
// session/request_permission is auto-answered with the first allow_* option —
// bandit's gate (verification commands) is the real safety layer, and factory
// runs must not block on a human.

interface JsonRpcMsg { jsonrpc: "2.0"; id?: number | string; method?: string; params?: any; result?: any; error?: any }

// Model preference for an ACP run: explicit cfg.model ("provider/id" or bare
// id) wins; else first non-claude catalog entry; else the adapter default.
function acpModel(cfg: TransportConfig, catalog: string[]): string | null {
  const explicit = cfg.model ?? cfg.args?.[cfg.args.indexOf("--model") + 1];
  const want = (explicit ?? "").replace(/^ollama\//, "");
  if (want) return want;
  return catalog.find((m) => !m.startsWith("claude")) ?? null;
}

async function acpPrompt(cfg: TransportConfig, prompt: string, cwd: string, timeoutMs: number): Promise<string> {
  // Model routing: ANTHROPIC_MODEL env makes the adapter resolve the model at
  // session create (it lands in configOptions AND becomes current). The
  // set_config_option path can't add models — it only selects within the
  // session-create catalog, so env is the reliable route.
  const model = acpModel(cfg, []);
  const acpEnv = model ? { ANTHROPIC_MODEL: model } : {};
  const proc = Bun.spawn([cfg.command, ...cfg.args], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...acpEnv, ...(cfg.env ?? {}) },
  });
  const send = (msg: JsonRpcMsg) => proc.stdin.write(JSON.stringify(msg) + "\n");
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);

  const result = await new Promise<{ text: string; error?: string }>((resolve) => {
    let buffer = "";
    let sessionId: string | null = null;
    let permissionOptions: { optionId: string; kind: string }[] = [];
    let text = "";
    let requestCounter = 0;
    let finished = false;
    const finish = (r: { text: string; error?: string }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(r);
      try { proc.kill(); } catch {}
    };
    const pump = async () => {
      for await (const chunk of proc.stdout as unknown as ReadableStream<Uint8Array>) {
        buffer += new TextDecoder().decode(chunk);
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let msg: JsonRpcMsg;
          try { msg = JSON.parse(line); } catch { continue; }
          // requests FROM the agent (id + method) need answers
          if (msg.method === "session/request_permission") {
            permissionOptions = msg.params?.options ?? [];
            const allow = permissionOptions.find((o) => o.kind === "allow_always") ?? permissionOptions.find((o) => o.kind === "allow_once");
            send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allow?.optionId ?? permissionOptions[0]?.optionId ?? "allow" } } });
            continue;
          }
          if (msg.method === "fs/read_text_file") {
            try {
              const limit = msg.params?.limit ? ` head -${msg.params.limit}` : "";
              const offset = msg.params?.line ? ` tail -n +${msg.params.line}` : "";
              const content = Bun.spawnSync(["bash", "-c", `cat ${JSON.stringify(msg.params.path)}${offset}${limit}`]).stdout.toString();
              send({ jsonrpc: "2.0", id: msg.id, result: { content } });
            } catch (e) {
              send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e) } });
            }
            continue;
          }
          if (msg.method === "fs/write_text_file") {
            try {
              const dir = msg.params.path.split("/").slice(0, -1).join("/");
              if (dir) mkdirSync(dir, { recursive: true });
              writeFileSync(msg.params.path, msg.params.content ?? "");
              send({ jsonrpc: "2.0", id: msg.id, result: {} });
            } catch (e) {
              send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e) } });
            }
            continue;
          }
          if (msg.id !== undefined && (msg.method || msg.result !== undefined || msg.error !== undefined)) {
            // a response to something we did not send — ignore; responses we
            // await are matched by id below.
          }
          // responses to OUR requests
          if (msg.id === 1) {
            // gateway capability: when the profile declares one, authenticate
            // first (client-managed LLM routing — the adapter never needs its
            // own claude login; e.g. ollama's anthropic-compatible endpoint).
            if (cfg.gateway) {
              send({
                jsonrpc: "2.0", id: 8, method: "authenticate",
                params: {
                  methodId: "gateway",
                  _meta: { gateway: { baseUrl: cfg.gateway.baseUrl, headers: cfg.gateway.headers } },
                },
              });
            } else {
              send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
            }
          } else if (msg.id === 8) {
            send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
          } else if (msg.id === 2) {
            sessionId = msg.result?.sessionId;
            if (!sessionId) { finish({ text: "", error: "session/new returned no sessionId" }); return; }
            // claude's "Manual" mode asks before every edit — switch to
            // acceptEdits so factory turns never block on permission.
            send({ jsonrpc: "2.0", id: 6, method: "session/set_mode", params: { sessionId, modeId: "acceptEdits" } });
          } else if (msg.id === 6) {
            // model routing: adapters expose their catalog as configOptions;
            // pick cfg.model (or the first non-claude entry) so non-Claude
            // backends (ollama gateway etc.) actually run the intended model.
            const opts: any[] = msg.result?.configOptions ?? [];
            const modelOpt = opts.find((o) => o?.id === "model");
            if (modelOpt) {
              const catalog: string[] = (modelOpt?.options ?? []).map((o: any) => o?.value).filter(Boolean);
              const want = acpModel(cfg, catalog);
              send({ jsonrpc: "2.0", id: 7, method: "session/set_config_option", params: { sessionId, configId: "model", value: want } });
            } else {
              send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: prompt }] } });
            }
          } else if (msg.id === 7) {
            send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: prompt }] } });
          } else if (msg.id === 3) {
            // turn complete
            const stop = msg.result?.stopReason ?? "end_turn";
            finish({ text: stop === "end_turn" ? text : `${text}\n[ACP_STOP: ${stop}]`, error: stop === "refusal" ? "refusal" : undefined });
          }
          // notifications: collect streamed agent output
          if (msg.method === "session/update" && msg.params?.sessionId === sessionId) {
            const u = msg.params.update;
            if (u?.sessionUpdate === "agent_message_chunk") {
              const blocks: any[] = Array.isArray(u.content) ? u.content : [u.content];
              for (const b of blocks) {
                if (b && typeof b === "object" && (b as Record<string, unknown>).type === "text") {
                  text += String((b as Record<string, unknown>).text ?? "");
                }
              }
            }
          }
        }
      }
      // stdout closed before a stopReason — treat as plumbing
      finish({ text, error: finished ? undefined : "acp stream closed before stopReason" });
    };
    void pump();
    void (async () => {
      const err = await new Response(proc.stderr).text();
      if (!finished && err && text.length === 0 && err.includes("ECONNREFUSED")) finish({ text: "", error: err.slice(0, 200) });
    })();
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, auth: { _meta: { gateway: true } } },
        clientInfo: { name: "bandit", version: "0.1.0" },
      },
    });
  });
  return result.text;
}

// ── GATE STAGE (verification + container + fingerprint) ──

export function parseGate(output: string): GateResult {
  const cmdMatch = output.match(/VERIFICATION_COMMAND:?\s*\*{0,2}\s*(.+)/i);
  const exitMatch = output.match(/VERIFICATION_EXIT_CODE:?\s*\*{0,2}\s*(\d+)/i);
  const outMatch = output.match(/VERIFICATION_OUTPUT:?\s*\*{0,2}\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/i);
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