// Seed check: port-guard. Human-owned; a candidate that edits this file is rejected by the judge.
// Run: bun test ./tests/seed/port-guard.check.ts   (the ./ matters: *.check.ts is outside bun's default glob)
//
// The guard verb of the harness-neutral port: any host asks "may these paths be edited?" before it edits.
// src/port.ts exports
//   protectedList(repoDir) -> string[]: kernel PROTECTED_PATHS + `protected` of <repoDir>/bandit.json (when it
//     parses) + every `checkPaths` entry of every <repoDir>/checks/*.json (files that do not parse are skipped)
//   guard(repoDir, paths) -> { allowed, hits, protected }: hits as protectedHits matches them (an entry ending
//     in "/" by prefix, any other entry exactly), paths relative to repoDir or absolute; an absolute path inside
//     repoDir is made relative, a path outside repoDir (absolute, or relative with "..") is never a hit.
// `bandit guard [--json] [--repo <dir>] <path>...` (repo defaults to cwd): exit 0 allowed, 1 any hit (hits one
// per line on stdout, or the JSON object as the last stdout line with --json), 2 usage error. Read-only.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, realpathSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { PROTECTED_PATHS } from "../../src/kernel/judge";

const SRC = join(import.meta.dir, "..", "..", "src");
const PORT = join(SRC, "port.ts");
const CLI = join(SRC, "cli.ts");

async function port(): Promise<any> {
  expect(existsSync(PORT)).toBe(true);
  const mod: any = await import(PORT);
  expect(typeof mod.guard).toBe("function");
  expect(typeof mod.protectedList).toBe("function");
  return mod;
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp(tag: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `seed-guard-${tag}-`)));
  dirs.push(d);
  return d;
}
function put(dir: string, rel: string, data: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}

// A repo dir with bandit.json (two extra entries) and two ratified checks, one of them with two paths.
// No .bandit folder, no git: the guard reads files only.
function repo(): string {
  const d = tmp("repo");
  put(d, "bandit.json", JSON.stringify({ gates: [["bun", "test"]], protected: ["tsconfig.json", "seed/"] }));
  put(d, "checks/alpha.json", JSON.stringify({ card: "alpha", verify: ["bun", "test", "./tests/seed/alpha.check.ts"], checkPaths: ["tests/seed/alpha.check.ts"], sha256: { "tests/seed/alpha.check.ts": "0".repeat(64) } }));
  put(d, "checks/beta.json", JSON.stringify({ card: "beta", verify: ["bash", "scripts/seed/beta.sh"], checkPaths: ["tests/seed/beta.check.ts", "scripts/seed/beta.sh"], sha256: { "tests/seed/beta.check.ts": "1".repeat(64), "scripts/seed/beta.sh": "2".repeat(64) } }));
  put(d, "checks/notes.txt", "not a ratification\n");
  put(d, "src/app.ts", "export {};\n");
  return d;
}

function cli(cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["bun", CLI, "guard", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}
function lastJson(stdout: string): any {
  const ls = stdout.trim().split("\n").filter((l) => l.trim());
  return JSON.parse(ls[ls.length - 1]);
}
function listing(d: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const n of readdirSync(join(d, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${n.name}` : n.name;
      out.push(r);
      if (n.isDirectory()) walk(r);
    }
  };
  walk("");
  return out.sort();
}

describe("seed port-guard: protectedList", () => {
  test("kernel list + bandit.json extras + every ratified check path", async () => {
    const { protectedList } = await port();
    const d = repo();
    const list: string[] = protectedList(d);
    for (const p of PROTECTED_PATHS) expect(list).toContain(p);
    for (const p of ["tsconfig.json", "seed/", "tests/seed/alpha.check.ts", "tests/seed/beta.check.ts", "scripts/seed/beta.sh", "checks/"]) expect(list).toContain(p);
    expect(new Set(list).size).toBe(list.length); // no duplicates
  });

  test("no bandit.json and no checks/: exactly the kernel list", async () => {
    const { protectedList } = await port();
    const d = tmp("bare");
    expect([...protectedList(d)].sort()).toEqual([...PROTECTED_PATHS].sort());
  });

  test("a bandit.json or a checks file that does not parse is skipped, never a throw", async () => {
    const { protectedList, guard } = await port();
    const d = tmp("broken");
    put(d, "bandit.json", "{ not json");
    put(d, "checks/bad.json", "{ nope");
    expect([...protectedList(d)].sort()).toEqual([...PROTECTED_PATHS].sort());
    expect(guard(d, ["src/kernel/judge.ts"]).allowed).toBe(false);
  });
});

describe("seed port-guard: guard", () => {
  test("a kernel path is a hit", async () => {
    const { guard } = await port();
    const d = repo();
    const r = guard(d, ["src/kernel/judge.ts"]);
    expect(r.allowed).toBe(false);
    expect(r.hits).toEqual(["src/kernel/judge.ts"]);
  });

  test("a ratified check path is a hit", async () => {
    const { guard } = await port();
    const d = repo();
    expect(guard(d, ["scripts/seed/beta.sh"]).hits).toEqual(["scripts/seed/beta.sh"]);
    expect(guard(d, ["tests/seed/alpha.check.ts"]).hits).toEqual(["tests/seed/alpha.check.ts"]);
  });

  test("a bandit.json extra entry is a hit (file exactly, directory by prefix)", async () => {
    const { guard } = await port();
    const d = repo();
    expect(guard(d, ["tsconfig.json"]).hits).toEqual(["tsconfig.json"]);
    expect(guard(d, ["seed/cards/x/card.md"]).hits).toEqual(["seed/cards/x/card.md"]);
    expect(guard(d, ["checks/new.json"]).hits).toEqual(["checks/new.json"]);
  });

  test("an ordinary src path is allowed; only the protected ones of a mixed list are hits, in input order", async () => {
    const { guard } = await port();
    const d = repo();
    const ok = guard(d, ["src/app.ts", "README.md", "src/kernelish.ts", "tsconfig.json.bak"]);
    expect(ok.allowed).toBe(true);
    expect(ok.hits).toEqual([]);
    const mixed = guard(d, ["src/app.ts", "bandit.json", "docs/a.md", "src/kernel/log.ts"]);
    expect(mixed.allowed).toBe(false);
    expect(mixed.hits).toEqual(["bandit.json", "src/kernel/log.ts"]);
  });

  test("a leading ./ is normalised away", async () => {
    const { guard } = await port();
    const d = repo();
    expect(guard(d, ["./src/kernel/card.ts"]).hits).toEqual(["src/kernel/card.ts"]);
  });

  test("an absolute path inside the repo is made relative", async () => {
    const { guard } = await port();
    const d = repo();
    const r = guard(d, [join(d, "src", "kernel", "judge.ts"), join(d, "src", "app.ts")]);
    expect(r.allowed).toBe(false);
    expect(r.hits).toEqual(["src/kernel/judge.ts"]);
  });

  test("a path outside the repo is allowed and never a hit", async () => {
    const { guard } = await port();
    const d = repo();
    const other = tmp("other");
    const r = guard(d, [join(other, "src", "kernel", "judge.ts"), "../elsewhere/bandit.json"]);
    expect(r.allowed).toBe(true);
    expect(r.hits).toEqual([]);
  });

  test("the result carries the protected list", async () => {
    const { guard, protectedList } = await port();
    const d = repo();
    const r = guard(d, ["src/app.ts"]);
    expect(Object.keys(r).sort()).toEqual(["allowed", "hits", "protected"]);
    expect(r.protected).toEqual(protectedList(d));
  });

  test("read-only: nothing is written, no .bandit appears", async () => {
    const { guard } = await port();
    const d = repo();
    const before = listing(d);
    guard(d, ["src/kernel/judge.ts", "src/app.ts"]);
    expect(listing(d)).toEqual(before);
    expect(existsSync(join(d, ".bandit"))).toBe(false);
  });
});

describe("seed port-guard: bandit guard", () => {
  test("allowed: exit 0, nothing on stdout", () => {
    const d = repo();
    const r = cli(d, "src/app.ts");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("hits: exit 1, one hit per line", () => {
    const d = repo();
    const r = cli(d, "src/app.ts", "src/kernel/judge.ts", "scripts/seed/beta.sh");
    expect(r.code).toBe(1);
    expect(r.stdout.trim().split("\n").map((l) => l.trim())).toEqual(["src/kernel/judge.ts", "scripts/seed/beta.sh"]);
  });

  test("--json: one object on the last stdout line, same exit codes", async () => {
    const { protectedList } = await port();
    const d = repo();
    const hit = cli(d, "--json", "src/kernel/judge.ts", "src/app.ts");
    expect(hit.code).toBe(1);
    const j = lastJson(hit.stdout);
    expect(Object.keys(j).sort()).toEqual(["allowed", "hits", "protected"]);
    expect(j).toEqual({ allowed: false, hits: ["src/kernel/judge.ts"], protected: protectedList(d) });
    const ok = cli(d, "--json", "src/app.ts");
    expect(ok.code).toBe(0);
    expect(lastJson(ok.stdout)).toMatchObject({ allowed: true, hits: [] });
  });

  test("--repo <dir> from another cwd; absolute paths inside it are relativised", () => {
    const d = repo();
    const elsewhere = tmp("cwd");
    const r = cli(elsewhere, "--json", "--repo", d, join(d, "tests", "seed", "alpha.check.ts"), join(d, "src", "app.ts"));
    expect(r.code).toBe(1);
    expect(lastJson(r.stdout)).toMatchObject({ allowed: false, hits: ["tests/seed/alpha.check.ts"] });
    expect(lastJson(r.stdout).protected).toContain("tests/seed/alpha.check.ts");
  });

  test("a path outside the repo is allowed", () => {
    const d = repo();
    const other = tmp("other");
    expect(cli(d, join(other, "bandit.json")).code).toBe(0);
  });

  test("a directory with no bandit.json, no checks and no .bandit: only the kernel list applies", () => {
    const d = tmp("plain");
    put(d, "README.md", "hi\n");
    const hit = cli(d, "--json", "package.json");
    expect(hit.code).toBe(1);
    const j = lastJson(hit.stdout);
    expect(j.hits).toEqual(["package.json"]);
    expect([...j.protected].sort()).toEqual([...PROTECTED_PATHS].sort());
    expect(cli(d, "tsconfig.json").code).toBe(0); // protected in the repo fixture, not here
    expect(existsSync(join(d, ".bandit"))).toBe(false);
  });

  test("usage errors exit 2: no paths, --repo without a value, an unknown flag", () => {
    const d = repo();
    expect(cli(d).code).toBe(2);
    expect(cli(d, "--json").code).toBe(2);
    expect(cli(d, "--repo").code).toBe(2);
    expect(cli(d, "--bogus", "src/app.ts").code).toBe(2);
  });

  test("read-only from the CLI too", () => {
    const d = repo();
    const before = listing(d);
    expect(cli(d, "--json", "src/kernel/judge.ts").code).toBe(1);
    expect(cli(d, "src/app.ts").code).toBe(0);
    expect(listing(d)).toEqual(before);
  });
});
