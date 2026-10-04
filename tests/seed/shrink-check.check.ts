// Seed check: shrink-check. Human-owned; a candidate that edits this file is rejected by the judge.
// Run: bun test ./tests/seed/shrink-check.check.ts   (the ./ matters: *.check.ts is outside bun's default glob)
//
// A deletion card is a card whose verify is `bun src/cli.ts shrink-check ...` next to the normal gates.
// src/shrink.ts exports
//   shrinkReport(repoDir, base, path = "src") -> { added, deleted, net, files }
//     from `git diff --numstat <base>...HEAD -- <path>` (three dots: since the merge base); binary rows
//     ("-\t-\t...") are ignored and not counted in files; net = added - deleted; throws when base does not resolve.
// `bandit shrink-check [--base <ref>] [--path <dir>] [--json]` in the repo at cwd:
//   exit 0 when net < 0, 1 when net >= 0, printing `added <a> deleted <d> net <n> files <f>` either way
//   (--json: { added, deleted, net, files, base } as one JSON line, the last line of stdout);
//   exit 2 on a usage error (a flag without its value, an unknown argument) or a base that does not resolve.
//   Default base: `main` when it resolves, else HEAD's first parent.
// `bun src/shrink.ts <same arguments>` does the same on its own (a deletion card pins src/shrink.ts and runs
// it directly), and src/shrink.ts imports only node builtins.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const SRC = join(import.meta.dir, "..", "..", "src");
const SHRINK = join(SRC, "shrink.ts");
const CLI = join(SRC, "cli.ts");

async function shrink(): Promise<any> {
  expect(existsSync(SHRINK)).toBe(true);
  const mod: any = await import(SHRINK);
  expect(typeof mod.shrinkReport).toBe("function");
  return mod;
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-c", "user.name=seed", "-c", "user.email=seed@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}
function put(dir: string, rel: string, data: string | Uint8Array): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join("\n") + "\n";
const BLOB = new Uint8Array([0, 1, 2, 3, 0, 255, 254, 0, 7]);
const BLOB2 = new Uint8Array([0, 9, 9, 9, 0, 255, 0, 0, 1, 2]);

// A repo on `branch` with one commit: src/a.ts (10 lines), src/b.ts (5), docs/x.md (3), src/blob.bin (binary).
// Then a `work` branch is checked out (unless work === false).
function repo(branch = "main", work = true): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "seed-shrink-")));
  dirs.push(d);
  git(d, "init", "-q", "-b", branch);
  put(d, "src/a.ts", lines(10, "a"));
  put(d, "src/b.ts", lines(5, "b"));
  put(d, "docs/x.md", lines(3, "x"));
  put(d, "src/blob.bin", BLOB);
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "base");
  if (work) git(d, "checkout", "-q", "-b", "work");
  return d;
}
function commit(d: string, msg = "change"): void {
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", msg);
}

function cli(d: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["bun", CLI, "shrink-check", ...args], { cwd: d, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}
function lastJson(stdout: string): any {
  const ls = stdout.trim().split("\n").filter((l) => l.trim());
  return JSON.parse(ls[ls.length - 1]);
}

describe("seed shrink-check: shrinkReport", () => {
  test("net negative: deleted lines in src outnumber added ones", async () => {
    const { shrinkReport } = await shrink();
    const d = repo();
    put(d, "src/a.ts", lines(4, "a"));                  // -6
    put(d, "src/b.ts", lines(5, "b") + "b 5\nb 6\n");   // +2
    commit(d);
    expect(shrinkReport(d, "main")).toEqual({ added: 2, deleted: 6, net: -4, files: 2 });
    expect(shrinkReport(d, "main", "src")).toEqual({ added: 2, deleted: 6, net: -4, files: 2 });
  });

  test("changes outside the path are ignored; another path is measured on its own", async () => {
    const { shrinkReport } = await shrink();
    const d = repo();
    put(d, "src/a.ts", lines(4, "a"));                  // src: -6
    put(d, "docs/x.md", lines(3, "x") + lines(50, "y")); // docs: +50
    commit(d);
    expect(shrinkReport(d, "main")).toEqual({ added: 0, deleted: 6, net: -6, files: 1 });
    expect(shrinkReport(d, "main", "docs")).toEqual({ added: 50, deleted: 0, net: 50, files: 1 });
  });

  test("binary files are ignored", async () => {
    const { shrinkReport } = await shrink();
    const d = repo();
    put(d, "src/blob.bin", BLOB2);
    put(d, "src/a.ts", lines(8, "a"));                  // -2
    commit(d);
    expect(shrinkReport(d, "main")).toEqual({ added: 0, deleted: 2, net: -2, files: 1 });
  });

  test("three dots: changes made on the base after the branch point do not count", async () => {
    const { shrinkReport } = await shrink();
    const d = repo();
    put(d, "src/a.ts", lines(4, "a"));                  // work: -6
    commit(d);
    git(d, "checkout", "-q", "main");
    put(d, "src/b.ts", lines(25, "b"));                 // main moves on: +20
    commit(d, "main moves on");
    git(d, "checkout", "-q", "work");
    expect(shrinkReport(d, "main")).toEqual({ added: 0, deleted: 6, net: -6, files: 1 });
  });

  test("a base that does not resolve throws", async () => {
    const { shrinkReport } = await shrink();
    const d = repo();
    expect(() => shrinkReport(d, "no-such-ref")).toThrow();
  });
});

describe("seed shrink-check: bandit shrink-check", () => {
  test("net negative exits 0 and prints the numbers", () => {
    const d = repo();
    put(d, "src/a.ts", lines(4, "a"));
    put(d, "src/b.ts", lines(5, "b") + "b 5\nb 6\n");
    commit(d);
    const j = cli(d, "--base", "main", "--json");
    expect(j.code).toBe(0);
    expect(lastJson(j.stdout)).toMatchObject({ added: 2, deleted: 6, net: -4, files: 2, base: "main" });
    const t = cli(d, "--base", "main");
    expect(t.code).toBe(0);
    expect(t.stdout).toMatch(/added 2 deleted 6 net -4 files 2/);
  });

  test("net zero exits 1", () => {
    const d = repo();
    put(d, "src/a.ts", lines(9, "a") + "a changed\n");   // +1 -1
    commit(d);
    const j = cli(d, "--base", "main", "--json");
    expect(j.code).toBe(1);
    expect(lastJson(j.stdout)).toMatchObject({ added: 1, deleted: 1, net: 0, files: 1 });
    const t = cli(d, "--base", "main");
    expect(t.code).toBe(1);
    expect(t.stdout).toMatch(/added 1 deleted 1 net 0 files 1/);
  });

  test("net positive exits 1", () => {
    const d = repo();
    put(d, "src/b.ts", lines(8, "b"));                   // +3
    commit(d);
    const j = cli(d, "--base", "main", "--json");
    expect(j.code).toBe(1);
    expect(lastJson(j.stdout)).toMatchObject({ added: 3, deleted: 0, net: 3, files: 1 });
  });

  test("--path: only that directory counts", () => {
    const d = repo();
    put(d, "src/a.ts", lines(4, "a"));
    put(d, "docs/x.md", lines(3, "x") + lines(50, "y"));
    commit(d);
    const s = cli(d, "--base", "main", "--json");
    expect(s.code).toBe(0);
    expect(lastJson(s.stdout)).toMatchObject({ added: 0, deleted: 6, net: -6, files: 1 });
    const p = cli(d, "--base", "main", "--path", "docs", "--json");
    expect(p.code).toBe(1);
    expect(lastJson(p.stdout)).toMatchObject({ added: 50, deleted: 0, net: 50, files: 1 });
  });

  test("binary-only growth does not count against a deletion", () => {
    const d = repo();
    put(d, "src/blob.bin", BLOB2);
    put(d, "src/big.bin", new Uint8Array(4096));         // new binary file
    put(d, "src/a.ts", lines(8, "a"));
    commit(d);
    const j = cli(d, "--base", "main", "--json");
    expect(j.code).toBe(0);
    expect(lastJson(j.stdout)).toMatchObject({ added: 0, deleted: 2, net: -2, files: 1 });
  });

  test("default base is main when it exists", () => {
    const d = repo();
    put(d, "src/a.ts", lines(4, "a"));                   // -6 against main
    commit(d);
    put(d, "src/b.ts", lines(6, "b"));                   // +1 in a second commit
    commit(d, "second");
    const j = cli(d, "--json");
    expect(j.code).toBe(0);
    expect(lastJson(j.stdout)).toMatchObject({ added: 1, deleted: 6, net: -5, files: 2, base: "main" });
  });

  test("default base without main: HEAD's first parent", () => {
    const d = repo("trunk", false);
    put(d, "src/b.ts", lines(9, "b"));                   // +4, in the first parent already
    commit(d, "grow");
    put(d, "src/a.ts", lines(7, "a"));                   // -3 in HEAD
    commit(d, "shrink");
    const j = cli(d, "--json");
    expect(j.code).toBe(0);
    expect(lastJson(j.stdout)).toMatchObject({ added: 0, deleted: 3, net: -3, files: 1 });
  });

  test("a base that does not resolve exits 2", () => {
    const d = repo();
    put(d, "src/a.ts", lines(4, "a"));
    commit(d);
    expect(cli(d, "--base", "no-such-ref").code).toBe(2);
    expect(cli(d, "--base", "no-such-ref", "--json").code).toBe(2);
  });

  test("no main and no parent: the default base does not resolve, exit 2", () => {
    const d = repo("trunk", false);
    expect(cli(d).code).toBe(2);
  });

  test("usage errors exit 2", () => {
    const d = repo();
    put(d, "src/a.ts", lines(4, "a"));
    commit(d);
    expect(cli(d, "--base").code).toBe(2);
    expect(cli(d, "--path").code).toBe(2);
    expect(cli(d, "--bogus").code).toBe(2);
  });
});

// A deletion card pins src/shrink.ts as its ratified check path and runs it directly, so the candidate
// cannot pass by editing the CLI: the module is its own entry point and imports only node builtins.
describe("seed shrink-check: src/shrink.ts runs on its own", () => {
  const direct = (d: string, ...args: string[]) => {
    const p = Bun.spawnSync(["bun", SHRINK, ...args], { cwd: d, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? 1, stdout: p.stdout.toString() };
  };

  test("bun src/shrink.ts takes the verb's arguments and exit codes", async () => {
    await shrink();
    const d = repo();
    put(d, "src/a.ts", lines(4, "a"));
    put(d, "src/b.ts", lines(5, "b") + "b 5\nb 6\n");
    commit(d);
    const j = direct(d, "--base", "main", "--json");
    expect(j.code).toBe(0);
    expect(lastJson(j.stdout)).toMatchObject({ added: 2, deleted: 6, net: -4, files: 2, base: "main" });
    expect(direct(d, "--base", "main", "--path", "docs").code).toBe(1);
    expect(direct(d, "--base", "no-such-ref").code).toBe(2);
    expect(direct(d, "--bogus").code).toBe(2);
  });

  test("src/shrink.ts imports nothing but node builtins", async () => {
    await shrink();
    const text = await Bun.file(SHRINK).text();
    const specifiers = [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specifiers.filter((s) => !s.startsWith("node:"))).toEqual([]);
  });
});
