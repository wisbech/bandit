// kernel/log.ts — the single owner of the event log (.bandit/events/).
// Every writer appends through appendEvent, every reader reads through
// readEvents or eventFiles. Paths come from an explicit board root, never cwd.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LogEvent = { type: string; ts: string; [k: string]: unknown };

function eventsDir(root: string): string {
  return join(root, ".bandit", "events");
}

// Every event file on the board, sorted by name (absolute paths).
export function eventFiles(root: string): string[] {
  const d = eventsDir(root);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(d, f));
}

export function appendEvent(root: string, type: string, payload: Record<string, unknown>): void {
  const d = eventsDir(root);
  mkdirSync(d, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(join(d, `${date}.jsonl`), JSON.stringify({ type, ts: new Date().toISOString(), ...payload }) + "\n", { flag: "a" });
}

export function readEvents(root: string, sinceTs?: string): LogEvent[] {
  const out: LogEvent[] = [];
  for (const f of eventFiles(root)) {
    for (const line of readFileSync(f, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!sinceTs || e.ts > sinceTs) out.push(e);
      } catch {}
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}
