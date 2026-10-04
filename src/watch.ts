import { existsSync, readFileSync, readdirSync, statSync, watch, closeSync, openSync, readSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { eventFiles } from "./kernel/log";

// watch.ts — the visibility adapter. Agents in bandit are headless processes;
// visibility comes from what they leave on disk: events (truth), card output
// files (live growth), and the process table (who is actually running).
// One render function, one subscription. KISS — no herdr, no panes.
//
// The wave view: rows per column, stage/role/gate per in-flight card, and the
// last consult exchange visible live — all fed by an incremental append tail
// (fs.watch wakes a byte-offset tail of events/*.jsonl; no poll repaint).

const COLUMNS = ["backlog", "in-progress", "review", "done"] as const;

function dir(...parts: string[]): string {
  return join(process.cwd(), ".bandit", ...parts);
}

function color(code: string, s: string): string {
  return `\x1b[${code}m${s}\x1b[0m`;
}

interface RunningAgent {
  pid: string;
  started: string;
  cardHint: string;
  model: string;
}

// Read the process table for agent CLI processes (opencode/claude/codex/pi/
// aider) — these are the factory's workers. pi runs as `pi --provider X
// --model Y ... -p`; opencode as `opencode run ...`; claude as `claude
// --print/-p`; codex/aider as themselves.
function runningAgents(): RunningAgent[] {
  try {
    const out = execSync(
      "ps -axo pid,lstart,command | grep -E 'opencode (run|--model)|claude .*(--print| -p)|pi (-p|--provider|--model)|codex (exec|--model)|aider' | grep -v grep",
      { encoding: "utf-8" },
    );
    return out.trim().split("\n").filter(Boolean).map((line) => {
      const parts = line.trim().split(/\s+/);
      const pid = parts[0];
      const command = parts.slice(3).join(" ");
      const modelMatch = command.match(/--model\s+(\S+)/);
      // card hint: which bandit prompt it carries
      const role = command.includes("You are actor") ? "actor"
        : command.includes("critic") ? "critic"
        : command.includes("master") ? "master" : "?";
      const agent = command.startsWith("opencode") ? "opencode"
        : command.startsWith("claude") ? "claude"
        : command.startsWith("pi") ? "pi"
        : command.startsWith("codex") ? "codex"
        : command.startsWith("aider") ? "aider" : "?";
      return {
        pid,
        started: `${parts[4]} ${parts[5]}`,
        cardHint: `${role} · ${agent}`,
        model: modelMatch?.[1] ?? "default",
      };
    });
  } catch {
    return [];
  }
}

// ── INCREMENTAL APPEND TAIL (events/*.jsonl, byte-offset, no poll repaint) ──
// fs.watch subscribes to .bandit/events/; on each append event a byte-offset
// tail reads only the newly grown bytes (from each file's remembered offset),
// parses the new complete lines, and feeds the render. No directory rescans,
// no re-reading whole files, no interval polling of file contents.

export interface WaveEvent {
  type: string;
  ts: string;
  [k: string]: unknown;
}

// One tail cursor per known jsonl: { offset } (bytes consumed) + a partial
// buffer for a line that ends mid-write (append split across wakeups).
interface TailState {
  offset: number;
  partial: string;
}

export class EventTail {
  private cursors = new Map<string, TailState>();
  public events: WaveEvent[] = [];
  public maxEvents = 400;

  // Read only the bytes appended since the last visit, per file. Returns the
  // newly parsed events. Incremental: files are read from their remembered
  // offset, never re-scanned; rotation (a new jsonl appearing) is picked up
  // by statting the dir on each fs.watch wakeup (cheap, event-gated).
  drain(): WaveEvent[] {
    const fresh: WaveEvent[] = [];
    for (const path of eventFiles(process.cwd())) {
      let size = 0;
      try { size = statSync(path).size; } catch { continue; }
      let cursor = this.cursors.get(path);
      if (!cursor) {
        // Fresh file (first sight: the initial render, or a rotation) — read
        // from 0 like `tail -F` picking up a file, then go incremental.
        cursor = { offset: 0, partial: "" };
        this.cursors.set(path, cursor);
      }
      if (size < cursor.offset) cursor = { offset: 0, partial: "" }; // truncated
      if (size <= cursor.offset) continue; // nothing appended since last visit
      const fh = openSync(path, "r");
      try {
        const chunk = Buffer.alloc(size - cursor.offset);
        readSync(fh, chunk, 0, chunk.length, cursor.offset);
        const text = cursor.partial + chunk.toString("utf-8");
        const lines = text.split("\n");
        cursor.partial = lines.pop() ?? ""; // last line may end mid-append
        cursor.offset = size;
        for (const line of lines) {
          if (!line.trim()) continue;
          try { fresh.push(JSON.parse(line)); } catch {}
        }
      } finally {
        closeSync(fh);
      }
    }
    if (fresh.length) {
      this.events = [...this.events, ...fresh].slice(-this.maxEvents);
    }
    return fresh;
  }
}

// ── CONSULT TAIL (last master↔critic exchange per card) ──
// card/consult.md grows as "**by:**\n\n<text>\n\n" turns (loop.ts). The live
// view shows only the LAST exchange: the latest master turn and the latest
// critic turn, tail-trimmed. Reads the last ~2 KiB — the thread is append-only.

interface ConsultTurnView {
  by: string;
  text: string;
}

export function lastConsultTurns(cardDir: string): ConsultTurnView[] {
  const p = join(cardDir, "consult.md");
  if (!existsSync(p)) return [];
  let raw = "";
  try {
    const st = statSync(p);
    const read = Math.min(st.size, 2048);
    const fh = openSync(p, "r");
    try {
      const chunk = Buffer.alloc(read);
      readSync(fh, chunk, 0, read, st.size - read);
      raw = chunk.toString("utf-8");
    } finally {
      closeSync(fh);
    }
  } catch {
    return [];
  }
  const turns: ConsultTurnView[] = [];
  // Summoned voices write `**<role>:**` turns too (loop.ts summonConsultVoice)
  // — they are thread voices; render them with the same cell treatment.
  const parts = raw.split(/\*\*(master|critic|actor|researcher|architect|[a-z][a-z0-9-]*(?:-[a-z0-9]+)*-consult-[a-z0-9]+):\*\*/i);
  for (let i = 1; i < parts.length; i += 2) {
    const by = parts[i].trim().toLowerCase();
    const text = (parts[i + 1] ?? "").trim();
    if (!text) continue;
    turns.push({ by, text: text.slice(-400) });
  }
  return turns.slice(-2); // the last exchange (however many voices it took)
}

// Section headers: numbered (isoquant's "01 /" pattern), hairline always the
// same total length. The tokens live in docs/style-guide.md §2.
let sectionNo = 0;
function sectionHeader(title: string): string {
  sectionNo += 1;
  const label = String(sectionNo).padStart(2, "0") + " / " + title.toUpperCase();
  const line = "─".repeat(Math.max(4, 50 - label.length));
  return color("1;37", `${label} ${line}`);
}

function trimCell(s: string, width: number): string {
  return s.length > width ? s.slice(0, width - 1) + "…" : s.padEnd(width);
}

// ── WAVE ROWS (per column, stage/role/gate per in-flight card) ──

interface WaveCard {
  id: string;
  stage: string;
  role: string;
  gate: string;
  consult: ConsultTurnView[];
  bytes: number;
  outputs: number;
}

// Per in-flight card: stage = latest pipeline event, role = who is on it (the
// running agent's role hint when the process table knows, else the last
// actor-side event actor), gate = latest verification/gate signal.
function waveCard(root: string, cardDir: string, cardId: string, events: WaveEvent[]): WaveCard {
  const mine = events.filter((e) => e.card === cardId);
  const pipeline = [...mine].reverse().find((e) => e.type === "pipeline.selected")?.pipeline as string | undefined;
  const stage = pipeline ?? ([...mine].some((e) => e.type === "round.started") ? "running" : "unstarted");
  const gateEv = [...mine].reverse().find((e) =>
    e.type === "verification.green" || e.type === "verification.red" || e.type === "gate.selfverify");
  const gate = gateEv
    ? gateEv.type === "verification.green" ? "green"
      : gateEv.type === "verification.red" ? "red"
        : `self ${gateEv.reported ?? "?"}`
    : "none";
  // role: the process-table hint is authoritative when present; otherwise the
  // last round/gate event implies an actor, a consult event implies critic.
  let role = "?";
  const consultSeen = mine.some((e) => e.type.startsWith("consult."));
  if (consultSeen) role = "master↔critic";
  else if (mine.some((e) => e.type === "round.started")) role = "actor";
  // live output growth
  let bytes = 0, outputs = 0;
  const outputsDir = join(cardDir, "outputs");
  if (existsSync(outputsDir)) {
    try {
      for (const f of readdirSync(outputsDir)) {
        bytes += statSync(join(outputsDir, f)).size;
        outputs += 1;
      }
    } catch {}
  }
  void root;
  return { id: cardId, stage, role, gate, consult: lastConsultTurns(cardDir), bytes, outputs };
}

function waveRows(events: WaveEvent[]): string[] {
  const lines: string[] = [];
  const W = 34; // id cell width
  const inflight = new Set(["in-progress", "review"]);
  for (const col of COLUMNS) {
    const colDir = dir("board", col);
    let cardIds: string[] = [];
    try { cardIds = readdirSync(colDir).filter((n) => existsSync(join(colDir, n))); } catch {}
    if (cardIds.length === 0) continue;
    lines.push(color("1;37", `── ${col.toUpperCase()} (${cardIds.length}) ────────────────────────────`));
    for (const cardId of cardIds) {
      const cardDir = join(colDir, cardId);
      if (inflight.has(col)) {
        const c = waveCard(process.cwd(), cardDir, cardId, events);
        const row = `  ${color("33", "▸")} ${trimCell(cardId, W)} stage ${trimCell(c.stage, 10)} role ${trimCell(c.role, 14)} gate ${trimCell(c.gate, 10)} ${c.outputs} out ${c.bytes}B`;
        lines.push(row);
        if (c.consult.length > 0) {
          lines.push(color("90", "    └ consult:"));
          for (const t of c.consult) {
            const snippet = t.text.replace(/\s+/g, " ").slice(-120);
            const voiceColor = t.by === "master" ? "36" : t.by === "critic" ? "90" : "35"; // summoned voices in magenta
            lines.push(`        ${color(voiceColor, t.by + ">")} ${snippet}`);
          }
        }
      } else {
        lines.push(`  · ${trimCell(cardId, W)}`);
      }
    }
  }
  return lines;
}

export function renderWatch(tail?: EventTail): string {
  const lines: string[] = [];
  lines.push(color("1;36", "╔══ BANDIT LIVE ═══════════════════════════════════════╗"));

  // Agents (from the process table — the real workers)
  sectionNo = 0;
  lines.push(sectionHeader("agents"));
  const agents = runningAgents();
  if (agents.length === 0) {
    lines.push("  (no agents running — the loop is idle)");
  } else {
    for (const a of agents) {
      lines.push(`  ${color("36", "●")} pid ${a.pid} · ${color("1;37", a.cardHint)} · model ${a.model} · since ${a.started}`);
    }
  }

  // THE WAVE: rows per column, stage/role/gate per in-flight card, last
  // consult exchange under each in-flight card that has one.
  lines.push("");
  lines.push(sectionHeader("wave"));
  const events = tail ? tail.events : [];
  const rows = waveRows(events);
  if (rows.length === 0) lines.push("  (board empty)");
  else lines.push(...rows);

  lines.push("");
  lines.push(sectionHeader("board"));
  const counts: Record<string, number> = {};
  for (const col of COLUMNS) {
    try { counts[col] = readdirSync(dir("board", col)).length; } catch { counts[col] = 0; }
  }
  lines.push(`  backlog ${counts["backlog"]} │ in-progress ${counts["in-progress"]} │ review ${counts["review"]} │ done ${counts["done"]}`);

  // EVENTS (truth) — the tail's recent window (incremental, not a rescan)
  lines.push("");
  lines.push(sectionHeader("events · the truth"));
  const recent = (tail ? tail.events : []).slice(-12);
  if (recent.length === 0) lines.push("  (no events yet)");
  for (const e of recent) {
    const payload = Object.entries(e).filter(([k]) => !["type", "ts"].includes(k)).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(" ");
    lines.push(`  ${color("90", String(e.ts).slice(11, 19))} ${`${e.type} ${payload}`.slice(0, 110)}`);
  }

  lines.push(color("1;36", "╚════════════════════════════════════════════════════╝"));
  return lines.join("\n");
}

// `bandit watch` — the streaming subscriber (Brigade shape): fs.watch on
// .bandit/events/ + board columns drives an incremental append tail of
// events/*.jsonl. On each append: drain only new bytes → render-on-append.
// No poll repaint: renders fire on fs events (debounced), never on an
// interval that re-renders unchanged state. Ctrl+C exits.

export function watchLoop(intervalMs = 2000): () => void {
  let running = true;
  let dirty = true; // render once on start
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const tail = new EventTail();

  const render = () => {
    debounce = null;
    if (!running) return;
    tail.drain(); // incremental: only bytes appended since last render
    process.stdout.write("\x1b[2J\x1b[H"); // clear
    process.stdout.write(renderWatch(tail) + "\n");
  };

  // Coalesce fs event bursts into one render (append storms). The debounce
  // timer is NOT a poll: it renders only after an fs event marked dirty;
  // an idle board renders nothing.
  const markDirty = () => {
    if (!running || debounce) return;
    debounce = setTimeout(render, Math.min(intervalMs, 250));
  };

  const watchers: { close(): void }[] = [];
  // subscribe: events dir (the tail) + board columns (card moves/growth)
  for (const d of [dir("events"), ...COLUMNS.map((c) => dir("board", c))]) {
    try {
      const w = watch(d, { persistent: true }, markDirty);
      w.on("error", () => {}); // a deleted dir must not crash the watch
      watchers.push(w);
    } catch {}
  }

  render(); // first render on start (initial full drain)
  return () => {
    running = false;
    for (const w of watchers) { try { w.close(); } catch {} }
    if (debounce) clearTimeout(debounce);
  };
}

export function renderWatchForTests(root: string, events: WaveEvent[]): string {
  const prev = process.cwd();
  process.chdir(root);
  try {
    const tail = new EventTail();
    tail.events = events;
    return renderWatch(tail);
  } finally {
    process.chdir(prev);
  }
}

// fstatSync is used for tail cursor bookkeeping in future revisions.
void fstatSync;