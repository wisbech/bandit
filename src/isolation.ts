// isolation.ts — failed-card isolation (opt-in: .bandit/config.json
// "isolation": "worktree"). Each card works in .bandit/worktrees/<id> on
// branch bandit/<id>, cut from the project's HEAD. Green: the branch stays.
// Not green: worktree and branch go, the shared tree never saw the attempt.

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defaultExec } from "./runner";

const git = (cwd: string, ...args: string[]) => defaultExec(["git", ...args], cwd);

export function isolationMode(root: string): "shared" | "worktree" {
  try {
    return JSON.parse(readFileSync(join(root, ".bandit", "config.json"), "utf-8")).isolation === "worktree" ? "worktree" : "shared";
  } catch {
    return "shared";
  }
}

export function worktreeOf(root: string, id: string): { dir: string; branch: string } {
  return { dir: join(root, ".bandit", "worktrees", id), branch: `bandit/${id}` };
}

// Fresh worktree from HEAD. Leftovers from an interrupted run are dropped first;
// an existing bandit/<id> branch is reset (its old sha is returned for the record).
export function openWorktree(root: string, id: string): { dir: string; branch: string; resetFrom: string | null } {
  const { dir, branch } = worktreeOf(root, id);
  if (git(root, "check-ignore", "-q", ".bandit/worktrees/" + id).code !== 0) {
    const p = join(root, ".bandit", ".gitignore");
    const cur = existsSync(p) ? readFileSync(p, "utf-8") : "";
    if (!/^worktrees\/$/m.test(cur)) writeFileSync(p, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + "worktrees/\n");
  }
  if (existsSync(dir)) {
    git(root, "worktree", "remove", "--force", dir);
    rmSync(dir, { recursive: true, force: true });
  }
  git(root, "worktree", "prune");
  const prior = git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  const add = git(root, "worktree", "add", "-q", "-B", branch, dir, "HEAD");
  if (add.code !== 0) throw new Error(`isolation: git worktree add failed in ${root}: ${add.stderr.trim().slice(0, 200)}`);
  return { dir, branch, resetFrom: prior.code === 0 ? prior.stdout.trim() : null };
}

// Green: commit what the worker left uncommitted (never .bandit/), drop the
// worktree, keep the branch. A failed commit keeps the worktree — work is never thrown away.
export function keepWorktree(root: string, id: string, message: string): { branch: string; error: string | null } {
  const { dir, branch } = worktreeOf(root, id);
  git(dir, "add", "-A", "--", ".", ":(exclude).bandit");
  if (git(dir, "diff", "--cached", "--quiet").code !== 0) {
    const c = git(dir, "commit", "-q", "-m", message);
    if (c.code !== 0) return { branch, error: (c.stderr || c.stdout).trim().slice(0, 200) };
  }
  git(root, "worktree", "remove", "--force", dir);
  return { branch, error: null };
}

// Not green: nothing is left behind.
export function discardWorktree(root: string, id: string): string {
  const { dir, branch } = worktreeOf(root, id);
  git(root, "worktree", "remove", "--force", dir);
  rmSync(dir, { recursive: true, force: true });
  git(root, "worktree", "prune");
  git(root, "branch", "-q", "-D", branch);
  return branch;
}
