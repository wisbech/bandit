import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { splitArgv } from "./verify";

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
  reported?: string; // the actor's VERIFICATION_COMMAND — recorded, executed only in a container
  reason?: "unverifiable"; // red because nothing trusted could be run
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
    // A literal key hit wins: {{actor.output}} resolves vars["actor.output"]
    // before the dotted-path walk. This matters — the critic/judge templates
    // use dotted names, and a flat key that shadows the path is deliberate.
    if (key in vars && vars[key] !== undefined && vars[key] !== null) {
      const flat: unknown = vars[key];
      if (Array.isArray(flat)) return flat.map((c) => `- ${c}`).join("\n");
      return String(flat);
    }
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

// opencode --format json emits one JSON object per line (step_start, text,
// tool_use, tool_result, step_finish). Convert the event stream to the plain
// text the gate/parser expects: concat the text parts; tool activity becomes
// one line each so the transcript still shows what the agent DID.
export function eventsToText(eventsJsonl: string): { text: string; tokens: number } {
  const lines: string[] = [];
  const tokens = { input: 0, output: 0 };
  for (const line of eventsJsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "text") {
        const t = String(e.part?.text ?? e.text ?? "");
        if (t.trim()) lines.push(t);
      } else if (e.type === "tool_use" || e.type === "tool") {
        const name = e.part?.tool ?? e.tool ?? "tool";
        lines.push(`[tool: ${name}]`);
      } else if (e.type === "step_finish") {
        const t = e.part?.tokens ?? e.tokens ?? {}; // opencode 1.18 nests tokens under part
        tokens.input += Number(t.input ?? 0);
        tokens.output += Number(t.output ?? 0) + Number(t.reasoning ?? 0);
      }
    } catch {}
  }
  if (tokens.input + tokens.output > 0) lines.push(`[tokens: in=${tokens.input} out=${tokens.output}]`);
  return { text: lines.join("\n") + "\n", tokens: tokens.input + tokens.output };
}

// Run one prompt through the transport. Writes output to the card folder.
export async function runTransport(cfg: TransportConfig, prompt: string, cwd: string, outputPath: string, timeoutMs: number): Promise<RunResult> {
  mkdirSync(cwd, { recursive: true });
  if (cfg.kind === "headless") {
    // EVENT-DRIVEN LIVENESS (OmO "monitors, not polling" — the marble-of-doom fix, 2026-09-28):
    // The v2 design polled output-file growth every 10s and probed CPU% — but opencode
    // headless writes stdout ONLY at turn end, so a slow-but-working agent (model queued
    // on OLLAMA_NUM_PARALLEL=1, cold reload, long generation) is indistinguishable from a
    // hung one. Three production Sisyphus cycles traced to this (2026-09-28).
    // The fix: opencode `--format json` emits an event line per step AS IT HAPPENS
    // (step_start/text/tool/step_finish). We read line-by-line, append each event to the
    // output file immediately, and measure liveness as TIME SINCE LAST EVENT — a real
    // progress signal, not a heuristic. CPU probing is deleted; the queue is the signal.
    const isOpencode = cfg.command.includes("opencode");
    const streamJson = isOpencode && !cfg.args.includes("--format");
    const scratch = join(cwd, ".bandit", "tmp");
    mkdirSync(scratch, { recursive: true });
    const argv = streamJson ? [...cfg.args, "--format", "json", prompt] : [...cfg.args, prompt];
    const proc = Bun.spawn([cfg.command, ...argv], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TMPDIR: scratch, OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE ?? "30m" },
    });
    const startedAt = Date.now();
    const timer = setTimeout(() => proc.kill(), timeoutMs);

    const result = await new Promise<{ stdout: string; exitCode: number; stalled: boolean }>((resolve) => {
      let done = false;
      const finish = (stalled: boolean) => {
        if (done) return;
        done = true;
        clearInterval(idleWatch);
        resolve({ stdout: collected, exitCode: -1, stalled });
      };
      // Liveness by event arrival: an agent emitting events is working. The
      // grace covers model load (no events yet is expected then).
      const eventIdleLimit = 300_000; // 5 min without ANY event = stuck
      let lastEventAt = Date.now();
      let collected = "";
      let writeStream: import("bun").FileSink | null = null;
      const idleWatch = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        if (elapsed > timeoutMs) { try { proc.kill(); } catch {} finish(true); return; }
        if (Date.now() - lastEventAt > eventIdleLimit) {
          console.log(`      ⊘ agent idle (${Math.round(eventIdleLimit / 1000)}s since last event) — killing`);
          try { proc.kill(); } catch {}
          finish(true);
        }
      }, 10_000);
      // Stream: read stdout line-by-line; each line IS an event. Persist it
      // immediately (the file becomes the live transcript for watch/dossier).
      (async () => {
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        try {
          for (;;) {
            const { value, done: rd } = await reader.read();
            if (rd) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              lastEventAt = Date.now();
              collected += line + "\n";
              if (streamJson) {
                if (!writeStream) writeStream = Bun.file(outputPath).writer();
                writeStream.write(line + "\n");
              }
            }
          }
          if (writeStream) writeStream.flush();
        } catch {}
      })();
      proc.exited.then((code) => {
        if (done) return;
        done = true;
        clearInterval(idleWatch);
        resolve({ stdout: collected, exitCode: code, stalled: false });
      });
    });

    // The final output file: for streamed (json) runs, events land in the file
    // as they arrive; convert to the plain text the gate/parser expects.
    if (streamJson) {
      const { text, tokens } = eventsToText(result.stdout);
      // keep the raw event stream beside the text: tool inputs/outputs are the only record of what the agent did
      writeFileSync(outputPath.replace(/\.md$/, ".events.jsonl"), result.stdout);
      writeFileSync(outputPath, text);
      clearTimeout(timer);
      return { ok: !result.stalled && result.exitCode === 0, output: text, tokensUsed: tokens > 0 ? tokens : Math.ceil(text.length / 4) };
    }
    clearTimeout(timer);
    writeFileSync(outputPath, result.stdout);
    return { ok: !result.stalled && result.exitCode === 0, output: result.stdout, tokensUsed: Math.ceil(result.stdout.length / 4) };
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
  // Models wrap the command in markdown — backticks (`bun test`) or bold
  // (**bun test**). Strip the wrapper pair; executing literal backticks as
  // command substitution is the false red that burned the summon probe
  // ("bash: 4: command not found" while the work was real).
  const command = (cmdMatch?.[1]?.trim() ?? "")
    .replace(/^`(.*)`$/, "$1")
    .replace(/\*{2}$/, "")
    .trim();
  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : undefined;
  return {
    green: command.length > 0 && exitCode === 0,
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

export function agentProfilePath(root: string, role: string): string {
  return join(root, ".opencode", "agents", `${role}.md`);
}

export interface RunOptions {
  serfDir: string;
  cardDir: string;
  root: string; // project root (contains .bandit/) — the actor's cwd
  transport: TransportConfig;
  container?: string;
  vars: Record<string, unknown>;
  timeoutMs?: number;
  reducer?: { command: string; args: string[] }; // cheap model for log receipts (Evidence-Preserving Reducer)
}

// ── SELF-VERIFICATION GATE (SoL-Pi appropriation) ──
// The actor's reported VERIFICATION_EXIT_CODE is a claim, not a fact. The
// harness re-runs the reported command itself and uses the ACTUAL exit code.
// Capability metrics stay outside the agent's control — no gaming the gate.

export interface SelfVerifyResult {
  attempted: boolean;
  command?: string;
  reportedExitCode?: number;
  actualExitCode?: number;
  timedOut: boolean;
  outputBytes: number;
  outputPath?: string;
  container?: boolean; // verification ran inside the declared container (invariant #5)
  cardOwned: boolean; // the command came from the card's `verify:` frontmatter, not the actor
  unverifiable?: boolean; // actor-proposed command, no container: not run (fail-closed)
}

// Security (freeze §4): the actor's VERIFICATION_COMMAND is model-written
// text — a prompt injection in any file the actor reads would become a shell
// command on the operator's machine. So: the card's own `verify:` wins (L1);
// nothing goes through a shell, argv only (L2); an actor-proposed command runs
// only inside the declared container, otherwise the gate is unverifiable (L3).
export async function selfVerifyGateAsync(gate: GateResult, cardDir: string, timeoutMs = 300_000, container?: string, root?: string): Promise<SelfVerifyResult> {
  const cardVerify = existsSync(join(cardDir, "card.md")) ? parseCard(cardDir).frontmatter.verify : undefined;
  const cardOwned = Boolean(cardVerify);
  const command = cardVerify || gate.command;
  const result: SelfVerifyResult = { attempted: false, command, reportedExitCode: gate.exitCode, timedOut: false, outputBytes: 0, cardOwned };
  if (!command) return result;
  if (!cardOwned && !container) {
    result.unverifiable = true;
    return result;
  }
  const inner = splitArgv(command);
  if (inner.length === 0) return result;
  result.attempted = true;
  const logPath = join(cardDir, "verification-output.log");
  // Container enforcement (invariant #5, now actually enforced): when the
  // factory declares a verification container, the re-run goes THROUGH it —
  // docker exec. Before this, verificationContainer was advertised config
  // that the gate silently ignored (the enforcement-is-social bug class).
  const alreadyWrapped = inner[0] === "docker" && inner[1] === "exec" && inner[2] === container;
  const argv = container && !alreadyWrapped ? ["docker", "exec", container, ...inner] : inner;
  result.container = Boolean(container);
  // Re-run from the PROJECT ROOT, not the card folder: acceptance commands are
  // written against the project (bun test, pytest, …). Running them from
  // .bandit/board/<col>/<card>/ fails on cwd — the false red that burned
  // muky62ac for three rounds (self-verify reported=0, actual=1 with
  // "0 test files matching" — the actor's work was real, the seat's cwd was
  // wrong). The caller passes the project root; old callers without it fall
  // back to cardDir.
  const cwd = root ?? cardDir;
  result.outputPath = logPath;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    // argv[0] not found / not executable — the shell's 127, without a shell
    const msg = `${e instanceof Error ? e.message : String(e)}\n`;
    writeFileSync(logPath, msg);
    result.actualExitCode = 127;
    result.outputBytes = Buffer.byteLength(msg);
    return result;
  }
  // Combined stdout+stderr, in arrival order.
  const chunks: Uint8Array[] = [];
  const pump = async (s: ReadableStream<Uint8Array>) => { for await (const c of s) chunks.push(c); };
  const pumps = Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]).catch(() => {});
  const timer = setTimeout(() => { try { proc.kill(); } catch {} result.timedOut = true; }, timeoutMs);
  const code = await proc.exited;
  clearTimeout(timer);
  // A grandchild may hold the pipes open after exit/kill; don't wait on it forever.
  await Promise.race([pumps, new Promise((r) => setTimeout(r, 2_000))]);
  const out = Buffer.concat(chunks);
  writeFileSync(logPath, out);
  result.actualExitCode = result.timedOut ? 124 : code;
  result.outputBytes = out.length;
  return result;
}

// ── EVIDENCE-PRESERVING REDUCER (SoL-Pi appropriation) ──
// A cheap model compresses a large log into a compact receipt; a deterministic
// verifier checks the receipt (schema, source hash, exit status, exact quotes,
// size). On any failure → fall back to the original. The main agent keeps
// diagnosis; the reducer only extracts evidence.

export interface EvidenceReceipt {
  receipt: string | null;
  sourceBytes: number;
  receiptBytes: number;
  verified: boolean;
  reason?: string;
}

export function verifyReceipt(receipt: string, source: string, exitCode?: number): { ok: boolean; reason?: string } {
  // schema: RECEIPT header, SOURCE-HASH, EXIT, QUOTES with exact matches
  if (!/^RECEIPT:/m.test(receipt)) return { ok: false, reason: "missing RECEIPT header" };
  const hashLine = receipt.match(/SOURCE-HASH:\s*([a-f0-9]{8})/i);
  if (!hashLine) return { ok: false, reason: "missing SOURCE-HASH" };
  // djb2 over source, matching bandit's fingerprint() normalization-free form
  let h = 5381;
  for (let i = 0; i < source.length; i++) h = ((h << 5) + h + source.charCodeAt(i)) >>> 0;
  if (hashLine[1] !== h.toString(16).padStart(8, "0").slice(0, 8)) return { ok: false, reason: "source hash mismatch" };
  if (!/EXIT:\s*\d+/i.test(receipt)) return { ok: false, reason: "missing exit status" };
  const quotes = [...receipt.matchAll(/^QUOTE:\s*(.+)$/gmi)].map((m) => m[1].trim());
  if (quotes.length === 0) return { ok: false, reason: "no exact quotes" };
  for (const q of quotes.slice(0, 5)) {
    if (q.length < 8) return { ok: false, reason: "quote too short to verify" };
    if (!source.includes(q)) return { ok: false, reason: `quote not found in source: ${q.slice(0, 40)}` };
  }
  if (receipt.length >= source.length) return { ok: false, reason: "receipt not smaller than source" };
  return { ok: true };
}

export async function reduceEvidence(
  output: string,
  reducer: { command: string; args: string[] },
  exitCode?: number,
): Promise<EvidenceReceipt> {
  const sourceBytes = output.length;
  if (sourceBytes < 4096) return { receipt: null, sourceBytes, receiptBytes: 0, verified: false, reason: "below 4KiB threshold" };
  if (/password|secret|api[_-]?key|token/i.test(output.slice(0, 2000))) {
    return { receipt: null, sourceBytes, receiptBytes: 0, verified: false, reason: "credential-suspect content, no reduction" };
  }
  let h = 5381;
  for (let i = 0; i < output.length; i++) h = ((h << 5) + h + output.charCodeAt(i)) >>> 0;
  const hash = h.toString(16).padStart(8, "0").slice(0, 8);
  const prompt = [
    "Compress this command log into an evidence receipt. Keep the information needed to diagnose failures: exit status, error lines, test results.",
    "Format EXACTLY:",
    "RECEIPT: <one-line summary>",
    "SOURCE-HASH: " + hash,
    "EXIT: " + (exitCode ?? "unknown"),
    "QUOTE: <exact verbatim line copied from the log>  (3-5 quotes, each a full line from the log, unchanged)",
    "NOTES: <short diagnosis>",
    "",
    "LOG:",
    output.slice(0, 100_000),
  ].join("\n");
  try {
    const proc = Bun.spawn([reducer.command, ...reducer.args, prompt], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const text = await new Response(proc.stdout).text();
    const receipt = text.trim();
    const verdict = verifyReceipt(receipt, output);
    if (!verdict.ok) return { receipt: null, sourceBytes, receiptBytes: receipt.length, verified: false, reason: verdict.reason };
    return { receipt, sourceBytes, receiptBytes: receipt.length, verified: true };
  } catch (e) {
    return { receipt: null, sourceBytes, receiptBytes: 0, verified: false, reason: String(e) };
  }
}

// ── OBSERVATIONPACK (SoL-Pi appropriation) ──
// Large inputs to the next stage (the critic) become a stable handle (file on
// disk, exact and retrievable) + a bounded excerpt. Nothing is lost — the
// critic can read the file; we just stop paying to inline it.

export function packObservation(output: string, cardDir: string, label: string, thresholdBytes = 10_240): { text: string; archived: boolean; path?: string } {
  if (output.length <= thresholdBytes) return { text: output, archived: false };
  const packDir = join(cardDir, "observations");
  mkdirSync(packDir, { recursive: true });
  const path = join(packDir, `${label}.log`);
  writeFileSync(path, output);
  const head = output.split("\n").slice(0, 12).join("\n");
  const tail = output.split("\n").slice(-12).join("\n");
  const text = [
    `[OBSERVATION PACKED — ${output.length} bytes archived at ${path}]`,
    "--- head ---",
    head,
    "--- tail ---",
    tail,
    "[Use `sed -n 'X,Yp' " + path + "` to read exact ranges on demand.]",
  ].join("\n");
  return { text, archived: true, path };
}

// One complete execution: render prompt from bandit folder, run transport,
// evaluate the gate, persist output + gate fingerprint into the card folder.
// Then: self-verify the gate (re-run the reported command for the ACTUAL exit
// code) and reduce oversized logs into verified evidence receipts.
export async function runSerfOnCard(opts: RunOptions): Promise<{ run: RunResult; gate: GateResult; unchangedGate: boolean; selfVerify?: SelfVerifyResult; evidence?: EvidenceReceipt }> {
  const serf = readSerfFolder(opts.serfDir);
  const card = parseCard(opts.cardDir);
  const prompt = renderPrompt(serf.prompt, { ...opts.vars, serf: { name: serf.name }, card: { ...cardVars(card), dir: opts.cardDir } });

  const outputsDir = join(opts.cardDir, "outputs");
  mkdirSync(outputsDir, { recursive: true });
  const outputPath = join(outputsDir, `run-${Date.now().toString(36)}.md`);

  // Role-scoped capability profile: if the project defines an opencode agent
  // profile for this serf (.opencode/agents/<serf>.md), select it so the
  // harness enforces the serf's permission contract (critic read-only, etc.).
  const agentProfile = agentProfilePath(opts.root, serf.name);
  const transport = opts.transport.kind === "headless" && opts.transport.command === "opencode" && existsSync(agentProfile)
    ? { ...opts.transport, args: [...opts.transport.args, "--agent", serf.name] }
    : opts.transport;

  const run = await runTransport(transport, prompt, opts.root, outputPath, opts.timeoutMs ?? 600_000);
  let gate = parseGate(run.output);
  gate.reported = gate.command;

  // container stage
  if (opts.container && gate.command) {
    gate.inContainer = gate.command.includes(`docker exec ${opts.container}`);
  }

  // self-verification stage: trust nothing. The card's own verify command is
  // the truth when present; the actor's reported command is only a claim.
  let selfVerify: SelfVerifyResult | undefined;
  if (gate.command || card.frontmatter.verify) {
    selfVerify = await selfVerifyGateAsync(gate, opts.cardDir, 300_000, opts.container, opts.root);
    if (selfVerify.cardOwned) gate.command = selfVerify.command;
    if (selfVerify.unverifiable) {
      gate.green = false;
      gate.reason = "unverifiable";
    } else if (selfVerify.actualExitCode !== undefined) {
      gate.exitCode = selfVerify.actualExitCode;
      gate.green = selfVerify.actualExitCode === 0;
      gate.output = selfVerify.timedOut ? (gate.output ?? "") + "\n[self-verify: TIMED OUT]" : gate.output;
    }
  }

  // evidence-preserving reduction: big gate output becomes a verified receipt
  let evidence: EvidenceReceipt | undefined;
  if (opts.reducer && gate.command && run.output.length >= 4096) {
    evidence = await reduceEvidence(run.output, opts.reducer, gate.exitCode);
  }

  // gate fingerprint stage
  let unchangedGate = false;
  if (!gate.green && gate.fingerprint) {
    unchangedGate = loadGateFingerprints(opts.cardDir).includes(gate.fingerprint);
    saveGateFingerprint(opts.cardDir, gate.fingerprint);
  }

  return { run, gate, unchangedGate, selfVerify, evidence };
}