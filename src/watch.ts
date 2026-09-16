import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// watch.ts — the visibility adapter. Agents in bandit are headless processes;
// visibility comes from what they leave on disk: events (truth), card output
// files (live growth), and the process table (who is actually running).
// One render function, one loop. KISS — no herdr, no panes.

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

// Read the process table for agent CLI processes (opencode/claude/codex/pi)
// with a sizeable prompt argument — these are the factory's workers.
function runningAgents(): RunningAgent[] {
  try {
    const out = execSync("ps -axo pid,lstart,command | grep -E 'opencode (run|--model)|claude (--print|-p)' | grep -v grep", { encoding: "utf-8" });
    return out.trim().split("\n").filter(Boolean).map((line) => {
      const parts = line.trim().split(/\s+/);
      const pid = parts[0];
      const command = parts.slice(3).join(" ");
      const modelMatch = command.match(/--model\s+(\S+)/);
      // card hint: which bandit prompt it carries
      const role = command.includes("You are actor") ? "actor" : command.includes("critic") ? "critic" : command.includes("master") ? "master" : "?";
      return {
        pid,
        started: `${parts[4]} ${parts[5]}`,
        cardHint: `${role} · ${modelMatch?.[1] ?? "default"}`,
        model: modelMatch?.[1] ?? "default",
      };
    });
  } catch {
    return [];
  }
}

// Live output growth: the actor writes run-*.md as it works.
function cardProgress(): { card: string; bytes: number; outputs: number; lastModified: string }[] {
  const out: { card: string; bytes: number; outputs: number; lastModified: string }[] = [];
  for (const col of ["in-progress", "review"]) {
    const colDir = dir("board", col);
    if (!existsSync(colDir)) continue;
    for (const cardId of readdirSync(colDir)) {
      const actual = join(dir("board"), col, cardId, "outputs");
      if (!existsSync(actual)) continue;
      let bytes = 0, outputs = 0, last = "";
      try {
        for (const f of readdirSync(actual)) {
          const st = statSync(join(actual, f));
          bytes += st.size; outputs += 1;
          if (st.mtime.toISOString() > last) last = st.mtime.toISOString();
        }
      } catch {}
      out.push({ card: cardId, bytes, outputs, lastModified: last.slice(11, 19) });
    }
  }
  return out;
}

function recentEvents(limit = 12): { ts: string; line: string }[] {
  const eventsDir = dir("events");
  if (!existsSync(eventsDir)) return [];
  const today = new Date().toISOString().slice(0, 10);
  const candidates = readdirSync(eventsDir).filter((f) => f.endsWith(".jsonl")).sort().slice(-2);
  const out: { ts: string; line: string }[] = [];
  for (const f of candidates) {
    for (const line of readFileSync(join(eventsDir, f), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        const payload = Object.entries(e).filter(([k]) => !["type", "ts"].includes(k)).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(" ");
        out.push({ ts: e.ts.slice(11, 19), line: `${e.type} ${payload}`.slice(0, 110) });
      } catch {}
    }
  }
  return out.slice(-limit);
}

function boardLine(): string {
  const counts: Record<string, number> = {};
  for (const col of COLUMNS) {
    const colDir = dir("board", col);
    try { counts[col] = readdirSync(colDir).length; } catch { counts[col] = 0; }
  }
  return `backlog ${counts["backlog"]} │ in-progress ${counts["in-progress"]} │ review ${counts["review"]} │ done ${counts["done"]}`;
}

export function renderWatch(): string {
  const lines: string[] = [];
  lines.push(color("1;36", "╔══ BANDIT LIVE ═══════════════════════════════════════╗"));

  // Agents (from the process table — the real workers)
  lines.push(color("1;37", "── AGENTS (headless processes) ──────────────────────"));
  const agents = runningAgents();
  if (agents.length === 0) {
    lines.push("  (no agents running — the loop is idle)");
  } else {
    for (const a of agents) {
      lines.push(`  ${color("36", "●")} pid ${a.pid} · ${color("1;37", a.cardHint)} · model ${a.model} · since ${a.started}`);
    }
  }

  // Card live progress (output file growth)
  lines.push("");
  lines.push(color("1;37", "── CARDS IN FLIGHT (output growth) ─────────────────"));
  const progress = cardProgress();
  if (progress.length === 0) {
    lines.push("  (nothing in flight)");
  } else {
    for (const p of progress) {
      lines.push(`  ${color("33", "▸")} ${p.card.slice(0, 40)} — ${p.outputs} output(s), ${p.bytes} B, last write ${p.lastModified}`);
    }
  }

  lines.push("");
  lines.push(color("1;37", "── BOARD ────────────────────────────────────────────"));
  lines.push("  " + boardLine());

  lines.push("");
  lines.push(color("1;37", "── EVENTS (truth) ──────────────────────────────────"));
  const events = recentEvents();
  if (events.length === 0) lines.push("  (no events yet)");
  for (const e of events) {
    lines.push(`  ${color("90", e.ts)} ${e.line}`);
  }

  lines.push(color("1;36", "╚════════════════════════════════════════════════════╝"));
  return lines.join("\n");
}

// `bandit watch` — clear + render + sleep, until Ctrl+C.
export function watchLoop(intervalMs = 2000): () => void {
  let running = true;
  const tick = async () => {
    if (!running) return;
    process.stdout.write("\x1b[2J\x1b[H"); // clear
    process.stdout.write(renderWatch() + "\n");
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
  return () => {
    running = false;
    clearInterval(timer);
  };
}