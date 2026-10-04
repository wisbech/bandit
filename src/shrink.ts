import { spawnSync } from "node:child_process";

// shrink.ts — a deletion card's check: passes only when the branch removes more lines than it adds
// under a path. Runs on its own (`bun src/shrink.ts`) and imports only node builtins.

export type ShrinkReport = { added: number; deleted: number; net: number; files: number };

const USAGE = "usage: bandit shrink-check [--base <ref>] [--path <dir>] [--json]";

function git(repoDir: string, args: string[]) {
  return spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
}

function resolves(repoDir: string, ref: string): boolean {
  return git(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status === 0;
}

export function shrinkReport(repoDir: string, base: string, path = "src"): ShrinkReport {
  const p = git(repoDir, ["diff", "--numstat", `${base}...HEAD`, "--", path]);
  if (p.status !== 0) throw new Error(`git diff ${base}...HEAD failed: ${(p.stderr || p.error?.message || "").trim()}`);
  let added = 0, deleted = 0, files = 0;
  for (const line of p.stdout.split("\n")) {
    const [a, d] = line.split("\t");
    if (!line || a === "-") continue; // binary
    added += Number(a);
    deleted += Number(d);
    files++;
  }
  return { added, deleted, net: added - deleted, files };
}

export function shrinkMain(args: string[], repoDir: string = process.cwd()): number {
  let base: string | undefined, path = "src", json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if ((a === "--base" || a === "--path") && i + 1 < args.length) {
      if (a === "--base") base = args[++i];
      else path = args[++i];
    } else {
      console.error(USAGE);
      return 2;
    }
  }
  base ??= resolves(repoDir, "main") ? "main" : "HEAD^";
  if (!resolves(repoDir, base)) {
    console.error(`shrink-check: base does not resolve to a commit: ${base}`);
    return 2;
  }
  const r = shrinkReport(repoDir, base, path);
  if (json) console.log(JSON.stringify({ ...r, base }));
  else console.log(`added ${r.added} deleted ${r.deleted} net ${r.net} files ${r.files} (base ${base})`);
  return r.net < 0 ? 0 : 1;
}

if (import.meta.main) process.exit(shrinkMain(process.argv.slice(2)));
