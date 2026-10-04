import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { PROTECTED_PATHS, parseBanditJson, protectedHits } from "./kernel/judge";

// port.ts — the guard verb of the harness-neutral port. Reads files only.

export type GuardResult = { allowed: boolean; hits: string[]; protected: string[] };

export function protectedList(repoDir: string): string[] {
  const list: string[] = [...PROTECTED_PATHS];
  const banditFile = join(repoDir, "bandit.json");
  if (existsSync(banditFile)) {
    try {
      const extra = parseBanditJson(readFileSync(banditFile, "utf8"), "bandit.json").protected;
      if (extra) list.push(...extra);
    } catch { /* unparseable: adds nothing */ }
  }
  const checksDir = join(repoDir, "checks");
  let names: string[] = [];
  try { names = readdirSync(checksDir).filter((n) => n.endsWith(".json")).sort(); } catch { /* no checks/ */ }
  for (const n of names) {
    try {
      const paths = JSON.parse(readFileSync(join(checksDir, n), "utf8"))?.checkPaths;
      if (Array.isArray(paths)) list.push(...paths.filter((p: unknown): p is string => typeof p === "string"));
    } catch { /* skipped */ }
  }
  return [...new Set(list)];
}

export function guard(repoDir: string, paths: string[]): GuardResult {
  const root = resolve(repoDir);
  const inside: string[] = [];
  for (const p of paths) {
    const rel = isAbsolute(p) ? relative(root, p) : normalize(p);
    if (rel === "" || rel === "." || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) continue;
    inside.push(rel);
  }
  const list = protectedList(repoDir);
  const hits = protectedHits(inside, list);
  return { allowed: hits.length === 0, hits, protected: list };
}
