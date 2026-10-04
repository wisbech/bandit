// Seed check: adapters. Human-owned; a candidate that edits this file is rejected by the judge.
// Run: bun test ./tests/seed/adapters.check.ts   (the ./ matters: *.check.ts is outside bun's default glob)
//
// Thin, harness-specific glue that only calls the port (bandit guard / next / submit / status / accept).
// This check never depends on the port cards: wherever an adapter calls `bandit`, it is pointed at a stub.
//   a. adapters/git/pre-commit (POSIX sh, executable): `$BANDIT guard <staged paths>`; non-zero blocks the
//      commit and shows the hits; BANDIT_GUARD_ALLOW=1 lets it through with a warning; $BANDIT may be several
//      words (e.g. "bun /path/src/cli.ts"); default `bandit`.
//   b. adapters/claude-code-mod/: a Claude Code mod. hooks/register.js exports register(on, options) and
//      registers a `tool.call` hook ($, e, next). For Edit / Write (e.file_path) it runs
//      $.process.run([...cmd, "guard", "--json", "--repo", <await $.session.cwd()>, <path>], { cwd }) and
//      returns { deny } listing the hits when the guard does not allow the path (or cannot run); otherwise it
//      returns next(e). Other tools pass through with no process run. cmd = options.bandit split on
//      whitespace, default "bandit".
//   c. adapters/ci/github-accept.yml: on pull_request, setup-bun, full-history checkout, `bandit-card: <id>`
//      from the PR body (through env, never interpolated into a script), skip with a notice when absent,
//      `bun src/cli.ts accept <id> --ref <head sha>`.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, realpathSync, readFileSync, statSync, chmodSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const REPO = join(import.meta.dir, "..", "..");
const ADAPTERS = join(REPO, "adapters");
const GIT_HOOK_DIR = join(ADAPTERS, "git");
const PRE_COMMIT = join(GIT_HOOK_DIR, "pre-commit");
const MOD = join(ADAPTERS, "claude-code-mod");
const REGISTER = join(MOD, "hooks", "register.js");
const CI = join(ADAPTERS, "ci", "github-accept.yml");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmp(tag: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `seed-adapters-${tag}-`)));
  dirs.push(d);
  return d;
}
function put(dir: string, rel: string, data: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}

describe("seed adapters: the contract page", () => {
  test("adapters/README.md names every verb, its exit codes and the three steps", () => {
    const p = join(ADAPTERS, "README.md");
    expect(existsSync(p)).toBe(true);
    const t = readFileSync(p, "utf-8");
    for (const verb of ["bandit guard", "bandit next", "bandit submit", "bandit release", "bandit status", "bandit accept"]) expect(t).toContain(verb);
    for (const field of ["allowed", "hits", "workDir", "leaseUntil", "passed", "gates", "lastEventTs"]) expect(t).toContain(field);
    expect(t).toMatch(/three steps/i);
    expect(t).toMatch(/exit/i);
  });

  test("each adapter has a README section, and no adapter file is picked up by `bun test`", () => {
    for (const d of ["git", "claude-code-mod", "ci"]) expect(existsSync(join(ADAPTERS, d, "README.md"))).toBe(true);
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, n.name);
        if (n.isDirectory()) walk(p);
        else if (/(\.test\.|_test_|\.spec\.|_spec_)/.test(n.name)) bad.push(p);
      }
    };
    walk(ADAPTERS);
    expect(bad).toEqual([]);
  });
});

// ── a. git pre-commit ──

// A fake `bandit`: `guard` exits 1 and prints each argument that starts with src/kernel/, else exits 0.
// Every argument of every call is appended to calls.log, one per line, so the check sees what the hook asked.
function fakeBandit(dir: string): string {
  const p = join(dir, "fake-bandit");
  writeFileSync(p, [
    "#!/bin/sh",
    `for a in "$@"; do printf '%s\\n' "$a"; done >> "${join(dir, "calls.log")}"`,
    'if [ "$1" != "guard" ]; then echo "fake bandit: only guard" >&2; exit 2; fi',
    "shift",
    "hit=0",
    'for a in "$@"; do',
    '  case "$a" in',
    "    --*) ;;",
    '    src/kernel/*) echo "$a"; hit=1 ;;',
    "  esac",
    "done",
    'exit "$hit"',
  ].join("\n") + "\n");
  chmodSync(p, 0o755);
  return p;
}

function hookRepo(): { repo: string; stubDir: string; stub: string } {
  const repo = tmp("git");
  const stubDir = tmp("stub");
  const g = (...a: string[]) => {
    const p = Bun.spawnSync(["git", ...a], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${p.stderr.toString()}`);
  };
  g("init", "-q", "-b", "main");
  g("config", "user.name", "seed");
  g("config", "user.email", "seed@example.invalid");
  g("config", "commit.gpgsign", "false");
  put(repo, "README.md", "hi\n");
  g("add", "-A");
  g("commit", "-q", "--no-verify", "-m", "base");
  return { repo, stubDir, stub: fakeBandit(stubDir) };
}

// git commit with the adapter directory as the hooks path, so adapters/git/pre-commit is the hook that runs.
function commit(repo: string, env: Record<string, string>): { code: number; out: string } {
  const p = Bun.spawnSync(["git", "-c", `core.hooksPath=${GIT_HOOK_DIR}`, "commit", "-q", "-m", "change"], {
    cwd: repo, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env },
  });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
}
function stage(repo: string, rel: string): void {
  put(repo, rel, `// ${rel}\n`);
  const p = Bun.spawnSync(["git", "add", "--", rel], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
}
const head = (repo: string) => Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout.toString().trim();

describe("seed adapters: git pre-commit", () => {
  test("the hook exists, is executable and is a POSIX sh script", () => {
    expect(existsSync(PRE_COMMIT)).toBe(true);
    expect(statSync(PRE_COMMIT).mode & 0o111).not.toBe(0);
    expect(readFileSync(PRE_COMMIT, "utf-8").split("\n")[0]).toMatch(/^#!\s*\/bin\/sh\s*$/);
  });

  test("staging a protected file blocks the commit and lists the hit", () => {
    const { repo, stub } = hookRepo();
    stage(repo, "src/kernel/judge.ts");
    const before = head(repo);
    const r = commit(repo, { BANDIT: stub });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("src/kernel/judge.ts");
    expect(head(repo)).toBe(before);
  });

  test("staging an ordinary file passes, and the hook asked guard about exactly the staged paths", () => {
    const { repo, stubDir, stub } = hookRepo();
    stage(repo, "src/app.ts");
    stage(repo, "docs/a note.md");
    const before = head(repo);
    const r = commit(repo, { BANDIT: stub });
    expect(r.code).toBe(0);
    expect(head(repo)).not.toBe(before);
    const args = readFileSync(join(stubDir, "calls.log"), "utf-8").split("\n");
    expect(args).toContain("guard");
    expect(args).toContain("src/app.ts");
    expect(args).toContain("docs/a note.md"); // one argument, spaces and all
  });

  test("$BANDIT can be several words (e.g. `bun /path/src/cli.ts`)", () => {
    const { repo, stub } = hookRepo();
    stage(repo, "src/kernel/log.ts");
    const r = commit(repo, { BANDIT: `sh ${stub}` });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("src/kernel/log.ts");
    stage(repo, "src/ok.ts");
    Bun.spawnSync(["git", "reset", "-q", "--", "src/kernel/log.ts"], { cwd: repo });
    expect(commit(repo, { BANDIT: `sh ${stub}` }).code).toBe(0);
  });

  test("BANDIT_GUARD_ALLOW=1 bypasses with a printed warning", () => {
    const { repo, stub } = hookRepo();
    stage(repo, "src/kernel/judge.ts");
    const before = head(repo);
    const r = commit(repo, { BANDIT: stub, BANDIT_GUARD_ALLOW: "1" });
    expect(r.code).toBe(0);
    expect(head(repo)).not.toBe(before);
    expect(r.out).toMatch(/BANDIT_GUARD_ALLOW/);
    expect(r.out).toMatch(/warn/i);
  });

  test("a guard that cannot run blocks (fails closed)", () => {
    const { repo, stubDir } = hookRepo();
    stage(repo, "src/app.ts");
    const r = commit(repo, { BANDIT: join(stubDir, "no-such-bandit") });
    expect(r.code).not.toBe(0);
  });

  test("a staged deletion is guarded like any other staged path", () => {
    const { repo, stubDir, stub } = hookRepo();
    Bun.spawnSync(["git", "rm", "-q", "README.md"], { cwd: repo });
    expect(commit(repo, { BANDIT: stub }).code).toBe(0);
    expect(readFileSync(join(stubDir, "calls.log"), "utf-8").split("\n")).toContain("README.md");
  });
});

// ── b. Claude Code mod ──

type Handler = ($: any, e: any, next: any) => any;
type Reg = { event: string; matcher: Record<string, unknown> | null; handler: Handler };

async function loadMod(options?: Record<string, unknown>): Promise<Reg[]> {
  expect(existsSync(REGISTER)).toBe(true);
  const mod: any = await import(REGISTER);
  expect(typeof mod.register).toBe("function");
  const regs: Reg[] = [];
  // The docs' `on(eventName, [matcher], handler)`; it returns a registration with .catch(handler).
  const on = (event: string, a: any, b?: any) => {
    const r: Reg = typeof a === "function" ? { event, matcher: null, handler: a } : { event, matcher: a, handler: b };
    regs.push(r);
    return { catch: () => undefined };
  };
  mod.register(on, options ?? {});
  return regs;
}

// A matcher field is a value, an array of allowed values, or a regular expression (mods/events).
function matches(m: Record<string, unknown> | null, e: any): boolean {
  if (!m) return true;
  return Object.entries(m).every(([k, v]) =>
    Array.isArray(v) ? v.includes(e[k]) : v instanceof RegExp ? v.test(String(e[k])) : v === e[k]);
}

const PROJECT = "/work/project";

// A fake $: process.run answers with `answer`; every run is recorded.
function fake$(answer: { exitCode: number; stdout: string; stderr?: string } | "throw") {
  const runs: { argv: string[]; init: any }[] = [];
  const $ = {
    process: {
      run: async (argv: string[], init?: any) => {
        runs.push({ argv, init });
        if (answer === "throw") throw new Error("spawn failed");
        return { stderr: "", ...answer };
      },
    },
    session: { cwd: async () => PROJECT },
    ui: { log: () => undefined, toast: () => undefined, status: () => undefined, notice: () => undefined },
  };
  return { $, runs };
}

// Fire one tool.call through every matching hook as a middleware chain; the end of the chain stands for
// Claude Code running the tool.
async function fire(regs: Reg[], $: any, e: any): Promise<{ result: any; reached: any[] }> {
  const chain = regs.filter((r) => r.event === "tool.call" && matches(r.matcher, e));
  const reached: any[] = [];
  const at = (i: number) => async (ev: any): Promise<any> => {
    if (i === chain.length) { reached.push(ev); return { result: "tool ran" }; }
    return chain[i].handler($, ev, at(i + 1));
  };
  return { result: await at(0)(e), reached };
}

const ALLOWED = { exitCode: 0, stdout: JSON.stringify({ allowed: true, hits: [], protected: ["src/kernel/"] }) + "\n" };
const REFUSED = { exitCode: 1, stdout: JSON.stringify({ allowed: false, hits: ["src/kernel/judge.ts"], protected: ["src/kernel/"] }) + "\n" };

describe("seed adapters: Claude Code mod", () => {
  test("plugin files: manifest with a name, hooks.json pointing at register.js", () => {
    const manifest = JSON.parse(readFileSync(join(MOD, ".claude-plugin", "plugin.json"), "utf-8"));
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name).not.toMatch(/^(claude|anthropic|cc-plugin)/);
    const hooks = JSON.parse(readFileSync(join(MOD, "hooks", "hooks.json"), "utf-8"));
    expect(hooks.modules).toEqual(["./register.js"]);
    expect(manifest.userConfig?.bandit?.type).toBe("string");
  });

  test("register.js imports nothing (a mod reaches processes through $ only)", () => {
    const t = readFileSync(REGISTER, "utf-8");
    expect(t).not.toMatch(/^\s*import\s/m);
    expect(t).not.toMatch(/\brequire\s*\(/);
  });

  test("registers a tool.call hook", async () => {
    const regs = await loadMod();
    expect(regs.some((r) => r.event === "tool.call")).toBe(true);
  });

  for (const tool of ["Edit", "Write"]) {
    test(`${tool}: allowed path passes through unchanged after one guard call`, async () => {
      const regs = await loadMod();
      const { $, runs } = fake$(ALLOWED);
      const e = Object.freeze({ tool, file_path: `${PROJECT}/src/app.ts`, content: "x" });
      const { result, reached } = await fire(regs, $, e);
      expect(reached).toEqual([e]);
      expect(result).toEqual({ result: "tool ran" });
      expect(runs).toHaveLength(1);
      expect(runs[0].argv).toEqual(["bandit", "guard", "--json", "--repo", PROJECT, `${PROJECT}/src/app.ts`]);
      expect(runs[0].init).toMatchObject({ cwd: PROJECT });
    });

    test(`${tool}: a protected path is refused with { deny } naming the hit, and the tool never runs`, async () => {
      const regs = await loadMod();
      const { $ } = fake$(REFUSED);
      const e = Object.freeze({ tool, file_path: `${PROJECT}/src/kernel/judge.ts`, old_string: "a", new_string: "b" });
      const { result, reached } = await fire(regs, $, e);
      expect(reached).toEqual([]);
      expect(typeof result.deny).toBe("string");
      expect(result.deny).toContain("src/kernel/judge.ts");
    });
  }

  test("a guard that cannot run (non-JSON output, or a throw) refuses: fail closed", async () => {
    const regs = await loadMod();
    for (const answer of [{ exitCode: 127, stdout: "" }, { exitCode: 2, stdout: "usage: bandit guard\n" }, "throw" as const]) {
      const { $ } = fake$(answer);
      const { result, reached } = await fire(regs, $, Object.freeze({ tool: "Write", file_path: `${PROJECT}/src/app.ts`, content: "x" }));
      expect(reached).toEqual([]);
      expect(typeof result.deny).toBe("string");
    }
  });

  test("tools that do not write files pass through with no guard call", async () => {
    const regs = await loadMod();
    const { $, runs } = fake$(REFUSED);
    for (const e of [
      { tool: "Read", file_path: `${PROJECT}/src/kernel/judge.ts` },
      { tool: "Bash", command: "ls src/kernel" },
      { tool: "Grep", pattern: "x", path: `${PROJECT}/src/kernel` },
    ]) {
      const ev = Object.freeze(e);
      const { result, reached } = await fire(regs, $, ev);
      expect(reached).toEqual([ev]);
      expect(result).toEqual({ result: "tool ran" });
    }
    expect(runs).toHaveLength(0);
  });

  test("the bandit command is configurable through options.bandit (split on whitespace)", async () => {
    const regs = await loadMod({ bandit: "bun /opt/bandit/src/cli.ts" });
    const { $, runs } = fake$(ALLOWED);
    await fire(regs, $, Object.freeze({ tool: "Edit", file_path: `${PROJECT}/a.ts`, old_string: "a", new_string: "b" }));
    expect(runs[0].argv).toEqual(["bun", "/opt/bandit/src/cli.ts", "guard", "--json", "--repo", PROJECT, `${PROJECT}/a.ts`]);
  });
});

// ── c. GitHub Actions template (text-level) ──

describe("seed adapters: CI workflow template", () => {
  const text = () => {
    expect(existsSync(CI)).toBe(true);
    return readFileSync(CI, "utf-8");
  };

  test("runs on pull_request with full history and bun", () => {
    const t = text();
    expect(t).toMatch(/^on:/m);
    expect(t).toContain("pull_request");
    expect(t).toMatch(/fetch-depth:\s*0/);
    expect(t).toContain("oven-sh/setup-bun");
  });

  test("takes the card id from a `bandit-card: <id>` line of the PR body, through env only", () => {
    const t = text();
    expect(t).toContain("bandit-card:");
    const bodyLines = t.split("\n").filter((l) => l.includes("github.event.pull_request.body"));
    expect(bodyLines.length).toBeGreaterThan(0);
    for (const l of bodyLines) expect(l).toMatch(/^\s*[A-Z_][A-Z0-9_]*:\s*\$\{\{\s*github\.event\.pull_request\.body\s*\}\}\s*$/);
    expect(t).toContain("::notice");
  });

  test("runs bandit accept on the PR head sha, with the PR's base pinned as local main", () => {
    const t = text();
    expect(t).toMatch(/bun src\/cli\.ts accept\s+"?\$\{?CARD\}?"?\s+--ref\s+"?\$\{?HEAD_SHA\}?"?/);
    expect(t).toMatch(/HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/);
    expect(t).toMatch(/git branch -f main "?origin\/\$\{?BASE_REF\}?"?/);
    expect(t).toMatch(/BASE_REF:\s*\$\{\{\s*github\.event\.pull_request\.base\.ref\s*\}\}/);
  });
});
