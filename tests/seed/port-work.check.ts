// Seed check: port-work. Human-owned; a candidate that edits this file is rejected by the judge.
// Run: bun test ./tests/seed/port-work.check.ts   (the ./ matters: *.check.ts is outside bun's default glob)
//
// The worker side of the harness-neutral port: any external harness can be the worker.
//   bandit next --json [--id <card>] [--lease-min N]: claims the next backlog card with the kernel claimCard,
//     opens its worktree with openWorktree (always, whatever the isolation config), logs
//     port.next { card, workDir, branch, base, holder: "port", pid, startedAt, leaseUntil } and prints
//     { id, title, task, acceptance, context, verify, workDir, branch, base, protected, leaseUntil }.
//     Exit 0 with a card, 3 when the backlog is empty (prints {"id": null}), 2 on errors.
//   bandit submit <id> --json [--message <m>]: keepWorktree, then the kernel judge (acceptRef) on the kept
//     branch with the recorded base; passed -> done + card.completed { card, verdict: sha }, exit 0;
//     failed -> review + task.failed { card, reason: "judge", ... }, branch kept, exit 1. Prints
//     { id, passed, sha, branch, gates: [{ name, exitCode }], ratified }. Exit 2 (nothing touched) when the
//     card is unknown, not held by the port, or the worktree has nothing to submit.
//   bandit release <id>: discardWorktree, card back to backlog, port.released; exit 0, 2 when not held.
// The lease: the loop does not reclaim (or work) an in-progress card whose latest card.claimed matches the
// latest port.next for it (same pid and startedAt) while that port.next's leaseUntil is in the future.
// After the lease expires the card is reclaimable as any card whose claimant died.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, chmodSync, realpathSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { readEvents } from "../../src/kernel/log";
import { PROTECTED_PATHS } from "../../src/kernel/judge";

const SRC = join(import.meta.dir, "..", "..", "src");
const CLI = join(SRC, "cli.ts");

let root: string;
let prevCwd: string;
beforeEach(() => {
  prevCwd = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), "seed-portwork-")));
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: (p.stdout.toString() + p.stderr.toString()).trim() };
}
function gitOk(dir: string, ...args: string[]): string {
  const r = git(dir, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.out}`);
  return r.out;
}
function put(rel: string, data: string, base = root): void {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}

const TASK = "Write hello.txt at the repo root.";
const ACCEPTANCE = "- hello.txt exists\n- nothing else changes";
const CONTEXT = "A fixture card for the port.";

function card(id: string, verify: string, column = "backlog"): void {
  put(join(".bandit", "board", column, id, "card.md"),
    `---\nid: ${id}\ntitle: Card ${id}\nverify: ${verify}\n---\n# Card ${id}\n\n## Task\n${TASK}\n\n## Acceptance\n${ACCEPTANCE}\n\n## Context\n${CONTEXT}\n`);
}

// A git repo on main with bandit.json (an extra protected entry, no gates) and a board.
function fixture(): string {
  gitOk(root, "init", "-q", "-b", "main");
  gitOk(root, "config", "user.name", "seed");
  gitOk(root, "config", "user.email", "seed@example.invalid");
  gitOk(root, "config", "commit.gpgsign", "false");
  put("bandit.json", JSON.stringify({ protected: ["guarded/"] }) + "\n");
  put("guarded/keep.txt", "do not touch\n");
  put("src/app.ts", "export const app = 1;\n");
  put(".gitignore", ".bandit/\n");
  gitOk(root, "add", "-A");
  gitOk(root, "commit", "-q", "-m", "base");
  for (const col of ["backlog", "in-progress", "review", "done"]) mkdirSync(join(root, ".bandit", "board", col), { recursive: true });
  mkdirSync(join(root, ".bandit", "events"), { recursive: true });
  return gitOk(root, "rev-parse", "HEAD");
}

function cli(...args: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["bun", CLI, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}
function lastJson(stdout: string): any {
  const ls = stdout.trim().split("\n").filter((l) => l.trim());
  expect(ls.length).toBeGreaterThan(0);
  return JSON.parse(ls[ls.length - 1]);
}
const inCol = (col: string, id: string) => existsSync(join(root, ".bandit", "board", col, id, "card.md"));
const events = (type: string, id?: string) => readEvents(root).filter((e) => e.type === type && (id === undefined || e.card === id));
const branchSha = (id: string) => git(root, "rev-parse", "--verify", "--quiet", `refs/heads/bandit/${id}`);

function next(...extra: string[]): { code: number; j: any } {
  const r = cli("next", "--json", ...extra);
  return { code: r.code, j: r.code === 2 ? null : lastJson(r.stdout) };
}

describe("seed port-work: bandit next", () => {
  test("claims the first backlog card in id order and opens a real worktree on bandit/<id>", () => {
    const base = fixture();
    card("b-second", "test -f hello.txt");
    card("a-first", "test -f hello.txt");
    const { code, j } = next();
    expect(code).toBe(0);
    expect(Object.keys(j).sort()).toEqual(["acceptance", "base", "branch", "context", "id", "leaseUntil", "protected", "task", "title", "verify", "workDir"]);
    expect(j).toMatchObject({ id: "a-first", title: "Card a-first", task: TASK, acceptance: ACCEPTANCE, context: CONTEXT, verify: "test -f hello.txt", branch: "bandit/a-first", base });
    expect(realpathSync(j.workDir)).toBe(join(root, ".bandit", "worktrees", "a-first"));
    expect(gitOk(j.workDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("bandit/a-first");
    expect(gitOk(j.workDir, "rev-parse", "HEAD")).toBe(base);
    expect(inCol("in-progress", "a-first")).toBe(true);
    expect(inCol("backlog", "b-second")).toBe(true);
  });

  test("protected carries the guard list: the kernel list plus bandit.json's extra entries", () => {
    fixture();
    card("a-first", "true");
    const { j } = next();
    for (const p of PROTECTED_PATHS) expect(j.protected).toContain(p);
    expect(j.protected).toContain("guarded/");
  });

  test("the claim is the kernel's card.claimed, followed by port.next with a lease (default 2 h)", () => {
    const base = fixture();
    card("a-first", "true");
    const t0 = Date.now();
    const { j } = next();
    const claim = events("card.claimed", "a-first");
    expect(claim).toHaveLength(1);
    const pn = events("port.next", "a-first");
    expect(pn).toHaveLength(1);
    expect(pn[0]).toMatchObject({ card: "a-first", branch: "bandit/a-first", base, holder: "port", pid: claim[0].pid, startedAt: claim[0].startedAt });
    expect(realpathSync(String(pn[0].workDir))).toBe(join(root, ".bandit", "worktrees", "a-first"));
    const lease = Date.parse(String(pn[0].leaseUntil));
    expect(lease).toBeGreaterThan(t0 + 119 * 60_000);
    expect(lease).toBeLessThan(Date.now() + 121 * 60_000);
    expect(j.leaseUntil).toBe(pn[0].leaseUntil);
  });

  test("--lease-min N sets the lease", () => {
    fixture();
    card("a-first", "true");
    const t0 = Date.now();
    next("--lease-min", "5");
    const lease = Date.parse(String(events("port.next", "a-first")[0].leaseUntil));
    expect(lease).toBeGreaterThan(t0 + 4 * 60_000);
    expect(lease).toBeLessThan(Date.now() + 6 * 60_000);
  });

  test("--id names the card; a card not in backlog is an error (2)", () => {
    fixture();
    card("a-first", "true");
    card("b-second", "true");
    const { code, j } = next("--id", "b-second");
    expect(code).toBe(0);
    expect(j.id).toBe("b-second");
    expect(inCol("backlog", "a-first")).toBe(true);
    expect(cli("next", "--json", "--id", "b-second").code).toBe(2); // already held
    expect(cli("next", "--json", "--id", "nope").code).toBe(2);
  });

  test("isolation is always worktree for the port, whatever .bandit/config.json says", () => {
    fixture();
    put(".bandit/config.json", JSON.stringify({ isolation: "shared" }));
    card("a-first", "true");
    const { code, j } = next();
    expect(code).toBe(0);
    expect(existsSync(join(j.workDir, "src", "app.ts"))).toBe(true);
  });

  test("an empty backlog exits 3 with {\"id\": null}", () => {
    fixture();
    const r = cli("next", "--json");
    expect(r.code).toBe(3);
    expect(lastJson(r.stdout)).toEqual({ id: null });
    expect(events("card.claimed")).toHaveLength(0);
  });
});

describe("seed port-work: bandit submit", () => {
  test("a change with a passing verify: committed on bandit/<id>, judged, done, exit 0", () => {
    const base = fixture();
    card("a-first", "test -f hello.txt");
    const { j } = next();
    put("hello.txt", "hi\n", j.workDir);
    const r = cli("submit", "a-first", "--json", "--message", "port: hello");
    expect(r.code).toBe(0);
    const s = lastJson(r.stdout);
    expect(Object.keys(s).sort()).toEqual(["branch", "gates", "id", "passed", "ratified", "sha"]);
    expect(s).toMatchObject({ id: "a-first", passed: true, branch: "bandit/a-first", ratified: false });
    expect(s.gates).toContainEqual({ name: "verify", exitCode: 0 });
    for (const g of s.gates) expect(Object.keys(g).sort()).toEqual(["exitCode", "name"]);
    // the branch holds the commit, on top of the base
    const tip = branchSha("a-first");
    expect(tip.code).toBe(0);
    expect(tip.out).toBe(s.sha);
    expect(gitOk(root, "log", "-1", "--format=%s", s.sha)).toBe("port: hello");
    expect(gitOk(root, "rev-parse", `${s.sha}^`)).toBe(base);
    expect(gitOk(root, "show", `${s.sha}:hello.txt`)).toBe("hi");
    // the judge logged it, and only then the card completed
    const passed = events("acceptance.passed", "a-first");
    expect(passed).toHaveLength(1);
    expect(passed[0]).toMatchObject({ sha: s.sha, base });
    expect(events("card.completed", "a-first")).toEqual([expect.objectContaining({ card: "a-first", verdict: s.sha })]);
    expect(inCol("done", "a-first")).toBe(true);
    expect(inCol("in-progress", "a-first")).toBe(false);
  });

  test("a failing verify: review, task.failed reason judge, branch kept, exit 1", () => {
    fixture();
    card("a-first", "test -f missing.txt");
    const { j } = next();
    put("hello.txt", "hi\n", j.workDir);
    const r = cli("submit", "a-first", "--json");
    expect(r.code).toBe(1);
    const s = lastJson(r.stdout);
    expect(s).toMatchObject({ id: "a-first", passed: false, branch: "bandit/a-first" });
    expect(s.gates).toContainEqual({ name: "verify", exitCode: 1 });
    expect(inCol("review", "a-first")).toBe(true);
    expect(events("acceptance.failed", "a-first")).toHaveLength(1);
    expect(events("task.failed", "a-first")).toEqual([expect.objectContaining({ card: "a-first", reason: "judge" })]);
    expect(events("card.completed", "a-first")).toHaveLength(0);
    expect(branchSha("a-first").out).toBe(s.sha);
  });

  test("a change to a protected path fails with gate protected-paths (bandit.json at the base)", () => {
    fixture();
    card("a-first", "true");
    const { j } = next();
    put("guarded/keep.txt", "touched\n", j.workDir);
    const r = cli("submit", "a-first", "--json");
    expect(r.code).toBe(1);
    const s = lastJson(r.stdout);
    expect(s.passed).toBe(false);
    expect(s.gates).toContainEqual({ name: "protected-paths", exitCode: 1 });
    expect(inCol("review", "a-first")).toBe(true);
  });

  test("a commit the host made itself in the worktree is judged too", () => {
    fixture();
    card("a-first", "test -f hello.txt");
    const { j } = next();
    put("hello.txt", "hi\n", j.workDir);
    gitOk(j.workDir, "add", "hello.txt");
    gitOk(j.workDir, "commit", "-q", "-m", "host commit");
    const r = cli("submit", "a-first", "--json");
    expect(r.code).toBe(0);
    expect(gitOk(root, "log", "-1", "--format=%s", lastJson(r.stdout).sha)).toBe("host commit");
  });

  test("nothing changed: exit 2, and the card is still held (worktree, column, no verdict)", () => {
    fixture();
    card("a-first", "true");
    const { j } = next();
    const r = cli("submit", "a-first", "--json");
    expect(r.code).toBe(2);
    expect(inCol("in-progress", "a-first")).toBe(true);
    expect(existsSync(j.workDir)).toBe(true);
    expect(events("acceptance.started", "a-first")).toHaveLength(0);
    // still held: a real change afterwards submits
    put("hello.txt", "hi\n", j.workDir);
    expect(cli("submit", "a-first", "--json").code).toBe(0);
  });

  test("unknown card, a card the port does not hold, no id: exit 2, nothing moves", () => {
    fixture();
    card("a-first", "true");
    card("z-loop", "true", "in-progress");
    expect(cli("submit", "nope", "--json").code).toBe(2);
    expect(cli("submit", "a-first", "--json").code).toBe(2); // in backlog: not held
    expect(cli("submit", "z-loop", "--json").code).toBe(2);  // in progress, but no port.next
    expect(cli("submit").code).toBe(2);
    expect(inCol("backlog", "a-first")).toBe(true);
    expect(inCol("in-progress", "z-loop")).toBe(true);
  });
});

describe("seed port-work: bandit release", () => {
  test("release: back to backlog, no branch, no worktree, port.released", () => {
    fixture();
    card("a-first", "true");
    const { j } = next();
    put("hello.txt", "hi\n", j.workDir);
    const r = cli("release", "a-first");
    expect(r.code).toBe(0);
    expect(inCol("backlog", "a-first")).toBe(true);
    expect(inCol("in-progress", "a-first")).toBe(false);
    expect(existsSync(j.workDir)).toBe(false);
    expect(branchSha("a-first").code).not.toBe(0);
    expect(events("port.released", "a-first")).toHaveLength(1);
    // the card can be taken again
    expect(next().j.id).toBe("a-first");
  });

  test("release of a card the port does not hold: exit 2", () => {
    fixture();
    card("a-first", "true");
    expect(cli("release", "a-first").code).toBe(2);
    expect(cli("release", "nope").code).toBe(2);
    expect(inCol("backlog", "a-first")).toBe(true);
  });
});

// ── The important one: the loop must not take a card the port holds ──

function serfs(): void {
  for (const name of ["master", "critic", "actor"]) {
    put(join(".bandit", "serfs", name, "serf.md"), `# ${name}\n\n## Mission\nThe ${name} mission.\n`);
    put(join(".bandit", "serfs", name, "prompt.md"), `You are ${name}.\nTASK: {{card.task}}\n`);
  }
}
function stubWorker(): string {
  const stub = join(root, "stub.sh");
  writeFileSync(stub, [
    "#!/bin/sh",
    'if echo "$1" | grep -q "Grade the work"; then echo "VERDICT: pass\\nCONFIDENCE: 0.9\\nREASONING: ok"; exit 0; fi',
    'case "$1" in',
    '  *"CONSULT (routing)"*) echo "DECISION: escalate";;',
    '  *) echo "done\\nVERIFICATION_COMMAND: true\\nVERIFICATION_EXIT_CODE: 0\\nVERIFICATION_OUTPUT: fine";;',
    "esac",
  ].join("\n"));
  chmodSync(stub, 0o755);
  return stub;
}
async function loopOnce(stub: string): Promise<any> {
  process.chdir(root);
  const loop: any = await import(join(SRC, "loop.ts"));
  return loop.runLoop({ once: true, root, transport: { kind: "headless", command: stub, args: [] }, maxRetries: 1 });
}

describe("seed port-work: a port-held card is out of the loop's reach", () => {
  test("runLoop({once}) neither reclaims nor works a card the port holds; it works the rest; submit still works", async () => {
    fixture();
    serfs();
    const stub = stubWorker();
    card("a-held", "test -f hello.txt");
    card("b-free", "true");
    const { code, j } = next(); // the bandit next process has exited: its pid is dead now
    expect(code).toBe(0);
    expect(j.id).toBe("a-held");
    const r = await loopOnce(stub);
    expect(r.processed).toBe(1);
    expect(events("card.reclaimed", "a-held")).toHaveLength(0);
    expect(events("card.claimed", "a-held")).toHaveLength(1); // only the port's
    expect(events("card.claimed", "b-free")).toHaveLength(1); // the loop did run
    expect(inCol("in-progress", "a-held")).toBe(true);
    expect(existsSync(j.workDir)).toBe(true);
    expect(readFileSync(join(j.workDir, "src", "app.ts"), "utf-8")).toBe("export const app = 1;\n");
    // the hold survived the loop: the host finishes the card
    put("hello.txt", "hi\n", j.workDir);
    const s = cli("submit", "a-held", "--json");
    expect(s.code).toBe(0);
    expect(inCol("done", "a-held")).toBe(true);
  });

  test("after the lease expires the card is reclaimable like any dead claim", async () => {
    fixture();
    serfs();
    const stub = stubWorker();
    card("a-held", "true");
    expect(next("--lease-min", "0").code).toBe(0);
    await Bun.sleep(20);
    await loopOnce(stub);
    expect(events("card.reclaimed", "a-held")).toHaveLength(1);
    expect(events("card.claimed", "a-held")).toHaveLength(2); // the port's, then the loop's
    expect(inCol("in-progress", "a-held")).toBe(false);
  });
});
