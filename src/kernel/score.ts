// kernel/score.ts — the project's own outside measure. `score` in bandit.json
// is an argv run in the working tree; its stdout holds one JSON number or an
// object with a numeric `score`. Every reading is logged as score.read. The
// loop reads it after a judged keep and never gates on it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "./log";
import { defaultExec, parseBanditJson } from "./judge";

// The whole stdout, else its last non-empty line (tools print noise first).
export function parseScore(stdout: string): number | null {
  const lines = stdout.trim().split("\n").filter((l) => l.trim());
  for (const text of [stdout.trim(), lines[lines.length - 1] ?? ""]) {
    try {
      const v = JSON.parse(text);
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (v && typeof v === "object" && typeof v.score === "number" && Number.isFinite(v.score)) return v.score;
    } catch {}
  }
  return null;
}

export function scoreArgv(repoDir: string): string[] | null {
  const path = join(repoDir, "bandit.json");
  if (!existsSync(path)) return null;
  return parseBanditJson(readFileSync(path, "utf-8"), "bandit.json").score ?? null;
}

// null when no score is configured (nothing run, nothing logged) or the output
// is not a number (logged with value null).
export function readScore(root: string, repoDir: string, timeoutMs = 600_000): number | null {
  const argv = scoreArgv(repoDir);
  if (!argv) return null;
  let stdout = "";
  let exitCode = 127;
  try {
    const p = Bun.spawnSync(argv, { cwd: repoDir, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    stdout = p.stdout.toString();
    exitCode = p.exitCode ?? 124;
  } catch {}
  const value = exitCode === 0 ? parseScore(stdout) : null;
  const head = defaultExec(["git", "rev-parse", "HEAD"], repoDir);
  appendEvent(root, "score.read", { value, argv, sha: head.code === 0 ? head.stdout.trim() : null, exitCode });
  return value;
}
