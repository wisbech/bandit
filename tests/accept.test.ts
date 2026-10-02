import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acceptRef, defaultExec, AcceptError, type Exec } from "../src/accept";
import { readEvents } from "../src/loop";
import { nullPort } from "../src/decisions";
import { seedDefaultFolders } from "./v30-helpers";

// bandit accept: a verdict on any ref, in a throwaway worktree, by gates the
// worker does not own. Fixture: a real git repo with main + a feature branch.

let root: string;
let featSha: string;
let mainSha: string;

function git(...args: string[]): string {
  const r = defaultExec(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], root);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function worktreeCount(): number {
  return git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
}

function seedCard(id: string, verify: string | null, gates?: string[][]): void {
  const d = join(root, ".bandit", "board", "backlog", id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "card.md"), `---\ncolumn: backlog\nid: ${id}\n${verify ? `verify: ${verify}\n` : ""}---\n# ${id}\n\n## Acceptance\n- feature.txt exists\n`);
  if (gates) writeFileSync(join(root, ".bandit", "config.json"), JSON.stringify({ gates }));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bandit-accept-test-")));
  process.chdir(root);
  seedDefaultFolders(root);
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".bandit/\n");
  writeFileSync(join(root, "ok.txt"), "ok\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  mainSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "feat");
  writeFileSync(join(root, "feature.txt"), "feature\n");
  git("add", ".");
  git("commit", "-q", "-m", "feature");
  featSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
});

afterEach(() => {
  process.chdir("/");
  rmSync(root, { recursive: true, force: true });
});

test("pass: card verify + project gate green on the branch; events carry sha, exit codes, shadow", async () => {
  seedCard("c1", "grep -c feature feature.txt", [["test", "-f", "ok.txt"]]);
  const port = { ...nullPort(), demonstrates: async () => 0.9, vacuous: async () => 0.1 };
  const r = await acceptRef({ root, cardId: "c1", ref: "feat", port });
  expect(r.passed).toBe(true);
  expect(r.sha).toBe(featSha);
  expect(r.gates.map((g) => [g.name, g.exitCode])).toEqual([["verify", 0], ["gate-1", 0]]);
  expect(worktreeCount()).toBe(1);
  const types = readEvents().map((e) => e.type);
  expect(types).toEqual(expect.arrayContaining(["acceptance.started", "acceptance.passed"]));
  const passed = readEvents().find((e) => e.type === "acceptance.passed")!;
  expect(passed).toMatchObject({ card: "c1", ref: "feat", sha: featSha, shadow: { demonstrates: 0.9, vacuous: 0.1 } });
  expect((passed.gates as { durationMs: number }[])[0].durationMs).toBeGreaterThanOrEqual(0);
  // the caller's tree is untouched: still on main, no feature.txt
  expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git("status", "--porcelain")).toBe("");
});

test("fail on card verify: stops at the first failure, project gates not run, worktree removed", async () => {
  seedCard("c2", "test -f feature.txt", [["test", "-f", "ok.txt"]]);
  const r = await acceptRef({ root, cardId: "c2", ref: "main" });
  expect(r.passed).toBe(false);
  expect(r.sha).toBe(mainSha);
  expect(r.gates.map((g) => [g.name, g.exitCode])).toEqual([["verify", 1]]);
  expect(worktreeCount()).toBe(1);
  expect(readEvents().find((e) => e.type === "acceptance.failed")).toMatchObject({ card: "c2", sha: mainSha });
});

test("fail on a project gate", async () => {
  seedCard("c3", "test -f feature.txt", [["test", "-f", "ok.txt"], ["sh", "-c", "echo boom; exit 3"]]);
  const r = await acceptRef({ root, cardId: "c3", ref: featSha });
  expect(r.passed).toBe(false);
  expect(r.gates.map((g) => [g.name, g.exitCode])).toEqual([["verify", 0], ["gate-1", 0], ["gate-2", 3]]);
  expect(r.gates[2].output).toContain("boom");
  expect(worktreeCount()).toBe(1);
});

test("PR number resolves through gh (stubbed) + git fetch; --post comments the verdict", async () => {
  seedCard("c4", "test -f feature.txt");
  const calls: string[] = [];
  const exec: Exec = (argv, cwd) => {
    calls.push(argv.join(" "));
    if (argv[0] === "gh" && argv[2] === "view") return { code: 0, stdout: JSON.stringify({ headRefName: "feat", headRefOid: featSha }), stderr: "" };
    if (argv[0] === "gh" && argv[2] === "comment") return { code: 0, stdout: "", stderr: "" };
    if (argv[0] === "git" && argv[1] === "fetch") return { code: 0, stdout: "", stderr: "" };
    return defaultExec(argv, cwd);
  };
  const r = await acceptRef({ root, cardId: "c4", ref: "42", post: true, exec });
  expect(r.passed).toBe(true);
  expect(r.sha).toBe(featSha);
  expect(calls).toContain("gh pr view 42 --json headRefName,headRefOid");
  expect(calls).toContain("git fetch origin feat");
  const comment = calls.find((c) => c.startsWith("gh pr comment 42 --body "));
  expect(comment).toContain("PASSED");
  expect(worktreeCount()).toBe(1);
});

test("usage/resolution errors throw AcceptError and leave no worktree", async () => {
  seedCard("c5", "test -f feature.txt");
  seedCard("noverify", null);
  await expect(acceptRef({ root, cardId: "c5", ref: "no-such-branch" })).rejects.toBeInstanceOf(AcceptError);
  await expect(acceptRef({ root, cardId: "c5", ref: "feat", post: true })).rejects.toBeInstanceOf(AcceptError);
  await expect(acceptRef({ root, cardId: "nope", ref: "feat" })).rejects.toBeInstanceOf(AcceptError);
  await expect(acceptRef({ root, cardId: "noverify", ref: "feat" })).rejects.toBeInstanceOf(AcceptError);
  expect(worktreeCount()).toBe(1);
});

test("CLI exit codes: 0 pass, 1 fail, 2 usage", () => {
  seedCard("c6", "test -f feature.txt");
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const run = (...args: string[]) => Bun.spawnSync(["bun", cli, "accept", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode;
  expect(run("c6", "--ref", "feat")).toBe(0);
  expect(run("c6", "--ref", "main")).toBe(1);
  expect(run("c6")).toBe(2);
  expect(run("c6", "--ref", "no-such-branch")).toBe(2);
  expect(worktreeCount()).toBe(1);
});
