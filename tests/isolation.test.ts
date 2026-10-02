import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLoop, readEvents } from "../src/loop";
import { defaultExec } from "../src/runner";
import { seedDefaultFolders } from "./v30-helpers";

// Failed-card isolation: "isolation": "worktree" runs each card in
// .bandit/worktrees/<id> on bandit/<id>. Green keeps the branch; anything
// else leaves no branch, no worktree, and a clean shared tree.

let root: string;

function git(...args: string[]) {
  return defaultExec(["git", ...args], root);
}

// Actor writes <file> in its cwd; the grader passes; routing escalates.
function stub(file: string): string {
  const p = join(root, "stub.sh");
  writeFileSync(p, [
    "#!/bin/sh",
    'if echo "$1" | grep -q "Grade the work"; then echo "VERDICT: pass\\nCONFIDENCE: 0.9\\nREASONING: ok"; exit 0; fi',
    'case "$1" in',
    '  *"CONSULT (routing)"*) echo "DECISION: escalate";;',
    `  *"You are actor"*) echo work > ${file}; echo "done\\nVERIFICATION_COMMAND: true\\nVERIFICATION_EXIT_CODE: 0";;`,
    '  *) echo "noop";;',
    "esac",
  ].join("\n"));
  chmodSync(p, 0o755);
  return p;
}

function seedCard(id: string, verify: string): void {
  const d = join(root, ".bandit", "board", "backlog", id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "card.md"), `---\ncolumn: backlog\nid: ${id}\ntitle: ${id} title\nverify: ${verify}\n---\n# ${id}\n- works\n`);
}

function isolate(): void {
  writeFileSync(join(root, ".bandit", "config.json"), JSON.stringify({ isolation: "worktree" }));
}

// Shared-tree status outside the board (the board itself is untracked here,
// the project does not ignore .bandit/ — the harder case).
function dirtyOutsideBoard(): string[] {
  return git("status", "--porcelain", "--untracked-files=all").stdout.split("\n").filter((l) => l.trim() && !l.startsWith("?? .bandit/"));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bandit-iso-")));
  process.chdir(root);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  writeFileSync(join(root, "base.txt"), "base\n");
  writeFileSync(join(root, ".gitignore"), "stub.sh\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  seedDefaultFolders(root);
});

afterEach(() => {
  process.chdir("/");
  rmSync(root, { recursive: true, force: true });
});

test("green card: branch bandit/<id> carries the change; no worktree dir; shared tree untouched", async () => {
  isolate();
  seedCard("green", "test -f feature.txt"); // passes only where the actor worked
  const r = await runLoop({ once: true, root, transport: { kind: "headless", command: stub("feature.txt"), args: [] }, maxRetries: 1 });
  expect(r.completed).toBe(1);
  expect(git("show", "bandit/green:feature.txt").stdout).toBe("work\n");
  expect(git("log", "-1", "--format=%s", "bandit/green").stdout.trim()).toBe("bandit: green green title");
  expect(existsSync(join(root, ".bandit", "worktrees", "green"))).toBe(false);
  expect(git("worktree", "list", "--porcelain").stdout.split("\n").filter((l) => l.startsWith("worktree ")).length).toBe(1);
  expect(existsSync(join(root, "feature.txt"))).toBe(false);
  expect(dirtyOutsideBoard()).toEqual([]);
  expect(git("show", "bandit/green", "--stat").stdout).not.toContain(".bandit");
  expect(readEvents().find((e) => e.type === "converged")).toMatchObject({ card: "green", branch: "bandit/green" });
  // the project did not ignore .bandit/ — the worktrees dir is ignored via .bandit/.gitignore
  expect(readFileSync(join(root, ".bandit", ".gitignore"), "utf-8")).toBe("worktrees/\n");
  expect(git("check-ignore", "-q", ".bandit/worktrees/green").code).toBe(0);
});

test("failed card: no branch, no worktree, shared tree clean", async () => {
  isolate();
  seedCard("red", "test -f never.txt");
  const r = await runLoop({ once: true, root, transport: { kind: "headless", command: stub("junk.txt"), args: [] }, maxRetries: 1 });
  expect(r.failed).toBe(1);
  expect(git("rev-parse", "--verify", "--quiet", "refs/heads/bandit/red").code).not.toBe(0);
  expect(existsSync(join(root, ".bandit", "worktrees", "red"))).toBe(false);
  expect(git("worktree", "list", "--porcelain").stdout.split("\n").filter((l) => l.startsWith("worktree ")).length).toBe(1);
  expect(existsSync(join(root, "junk.txt"))).toBe(false);
  expect(dirtyOutsideBoard()).toEqual([]);
  expect(readEvents().find((e) => e.type === "isolation.discarded")).toMatchObject({ card: "red", branch: "bandit/red" });
  expect(existsSync(join(root, ".bandit", "board", "review", "red", "card.md"))).toBe(true);
});

test("shared mode (default): work lands in the project root, no branch, no worktrees, no .bandit/.gitignore", async () => {
  seedCard("shared", "test -f feature.txt");
  const r = await runLoop({ once: true, root, transport: { kind: "headless", command: stub("feature.txt"), args: [] }, maxRetries: 1 });
  expect(r.completed).toBe(1);
  expect(readFileSync(join(root, "feature.txt"), "utf-8")).toBe("work\n");
  expect(git("branch", "--list", "bandit/*").stdout.trim()).toBe("");
  expect(existsSync(join(root, ".bandit", "worktrees"))).toBe(false);
  expect(existsSync(join(root, ".bandit", ".gitignore"))).toBe(false);
  expect(readEvents().find((e) => e.type === "converged")).not.toHaveProperty("branch");
});
