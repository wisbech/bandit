// kernel/judge.ts — the acceptance verdict: card in, ref in, verdict out.
// The worker is anything that produced a branch; the gate (card verify +
// project gates) is one it does not own. Runs in a throwaway worktree, never
// the caller's tree. Deterministic: no model calls. Callers that want to
// record a model's opinion beside the verdict pass `annotate`; what it
// returns is logged with the verdict and can never change it.
//
// Checks the judged cannot edit: everything the verdict depends on is read
// from the BASE ref (default `main`), never from the candidate or the live
// card. A ratified check is checks/<card-id>.json committed on the base by a
// human (bandit ratify writes it; it never commits). bandit.json at the base
// holds setup, gates, score, extra protected paths and requireRatified.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { findCardDir, parseCard, splitArgv, type CardFolder } from "./card";
import { appendEvent } from "./log";

// Short synchronous tool calls (git, gh): argv, no shell. Injectable in tests.
export type Exec = (argv: string[], cwd: string) => { code: number; stdout: string; stderr: string };
export const defaultExec: Exec = (argv, cwd) => {
  try {
    const p = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) }; // not installed
  }
};

// One argv, no shell, in cwd: combined stdout+stderr and the exit code
// (127 = could not spawn, 124 = timed out). Shared by self-verify and accept.
export async function runArgv(argv: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number; timedOut: boolean; output: Buffer }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    // argv[0] not found / not executable — the shell's 127, without a shell
    return { exitCode: 127, timedOut: false, output: Buffer.from(`${e instanceof Error ? e.message : String(e)}\n`) };
  }
  // Combined stdout+stderr, in arrival order.
  const chunks: Uint8Array[] = [];
  const pump = async (s: ReadableStream<Uint8Array>) => { for await (const c of s) chunks.push(c); };
  const pumps = Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]).catch(() => {});
  let timedOut = false;
  const timer = setTimeout(() => { try { proc.kill(); } catch {} timedOut = true; }, timeoutMs);
  const code = await proc.exited;
  clearTimeout(timer);
  // A grandchild may hold the pipes open after exit/kill; don't wait on it forever.
  // 10 s: a judge that drops gate output under load is a correctness problem.
  await Promise.race([pumps, new Promise((r) => setTimeout(r, 10_000))]);
  return { exitCode: timedOut ? 124 : code, timedOut, output: Buffer.concat(chunks) };
}

// ── OBSERVATIONPACK (SoL-Pi appropriation) ──
// Large inputs to the next stage (the critic) become a stable handle (file on
// disk, exact and retrievable) + a bounded excerpt. Nothing is lost — the
// critic can read the file; we just stop paying to inline it.
export function packObservation(output: string, cardDir: string, label: string, thresholdBytes = 10_240): { text: string; archived: boolean; path?: string } {
  if (output.length <= thresholdBytes) return { text: output, archived: false };
  const packDir = join(cardDir, "observations");
  mkdirSync(packDir, { recursive: true });
  const path = join(packDir, `${label}.log`);
  writeFileSync(path, output);
  const head = output.split("\n").slice(0, 12).join("\n");
  const tail = output.split("\n").slice(-12).join("\n");
  const text = [
    `[OBSERVATION PACKED — ${output.length} bytes archived at ${path}]`,
    "--- head ---",
    head,
    "--- tail ---",
    tail,
    "[Use `sed -n 'X,Yp' " + path + "` to read exact ranges on demand.]",
  ].join("\n");
  return { text, archived: true, path };
}

// ── THE VERDICT ──

export interface AcceptOptions {
  root: string;    // board root (contains .bandit/)
  cardId: string;
  ref: string;     // branch | sha | PR number (digits only)
  repo?: string;   // git repo to check out from; defaults to root
  base?: string;   // ref the checks and bandit.json are read from; default `main` when it exists
  exec?: Exec;     // git/gh runner (tests stub gh); gates always run via runArgv
  timeoutMs?: number;
  // Extra fields logged with the verdict (e.g. a shadow reading). Called once
  // the verify gate has run; a throw is ignored; it cannot change the verdict.
  annotate?: (ctx: { card: CardFolder; verifyOutput: string }) => Promise<Record<string, unknown>>;
}

export interface GateRun { name: string; argv: string[]; exitCode: number; durationMs: number; output: string }

export interface AcceptResult {
  passed: boolean;
  sha: string;
  pr: number | null;
  gates: GateRun[];
  ratified: boolean;    // the verify argv came from checks/<card>.json at the base
  base: string | null;  // base sha, null when the repo has no base to read from
}

// Usage / resolution problems: the CLI maps these to exit 2, never to a verdict.
export class AcceptError extends Error {}

export function projectGates(root: string): string[][] {
  const path = join(root, ".bandit", "config.json");
  if (!existsSync(path)) return [];
  let gates: unknown;
  try {
    gates = JSON.parse(readFileSync(path, "utf-8")).gates;
  } catch {
    throw new AcceptError(".bandit/config.json is not valid JSON");
  }
  if (gates === undefined) return [];
  const ok = Array.isArray(gates) && gates.every((g) => Array.isArray(g) && g.length > 0 && g.every((a) => typeof a === "string"));
  if (!ok) throw new AcceptError('.bandit/config.json "gates" must be an array of argv arrays, e.g. [["bun","test"]]');
  return gates as string[][];
}

// ── bandit.json: the project's tracked config (read from the base by the judge) ──

export interface BanditJson { setup?: string[][]; gates?: string[][]; score?: string[]; protected?: string[]; requireRatified?: boolean }

const isArgv = (a: unknown): a is string[] => Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === "string");

export function parseBanditJson(raw: string, where: string): BanditJson {
  let j: Record<string, unknown>;
  try { j = JSON.parse(raw); } catch { throw new AcceptError(`${where} is not valid JSON`); }
  for (const k of ["setup", "gates"]) {
    if (j[k] !== undefined && !(Array.isArray(j[k]) && (j[k] as unknown[]).every(isArgv))) throw new AcceptError(`${where} "${k}" must be an array of argv arrays, e.g. [["bun","test"]]`);
  }
  if (j.score !== undefined && !isArgv(j.score)) throw new AcceptError(`${where} "score" must be one argv array, e.g. ["bun","run","score"]`);
  if (j.protected !== undefined && !(Array.isArray(j.protected) && j.protected.every((p) => typeof p === "string"))) throw new AcceptError(`${where} "protected" must be an array of paths`);
  return j as BanditJson;
}

// ── Ratified checks and protected paths ──

export interface Ratification { card: string; verify: string[]; checkPaths: string[]; sha256: Record<string, string> }

// A candidate whose diff against the base touches any of these fails the verdict.
// An entry ending in "/" protects everything under it. A human merges kernel changes.
export const PROTECTED_PATHS = [
  "checks/", "src/kernel/", "KERNEL.md", "CODEOWNERS", "bandit.json", "package.json", "bunfig.toml",
  "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
];

export function protectedHits(changed: string[], protectedList: string[]): string[] {
  return changed.filter((f) => protectedList.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));
}

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

function parseRatification(raw: string, where: string): Ratification {
  let r: Ratification;
  try { r = JSON.parse(raw); } catch { throw new AcceptError(`${where} is not valid JSON`); }
  const ok = isArgv(r.verify) && Array.isArray(r.checkPaths) && r.checkPaths.every((p) => typeof p === "string" && typeof r.sha256?.[p] === "string");
  if (!ok) throw new AcceptError(`${where} needs verify (argv), checkPaths and a sha256 for every check path`);
  return r;
}

// Human-run: write checks/<card-id>.json from the working tree. It does not
// commit; the commit on the base branch is the ratification. The event is the record.
export function ratify(root: string, repo: string, cardId: string, paths: string[], verify?: string): { file: string; ratification: Ratification } {
  const cardDir = findCardDir(root, cardId);
  if (!cardDir) throw new AcceptError(`no card ${cardId} in any column`);
  const argv = splitArgv(verify ?? parseCard(cardDir).frontmatter.verify ?? "");
  if (argv.length === 0) throw new AcceptError(`card ${cardId} has no verify: and no --verify was given`);
  if (paths.length === 0) throw new AcceptError("--paths names at least one check file");
  const hashes: Record<string, string> = {};
  for (const p of paths) {
    if (isAbsolute(p) || normalize(p).startsWith("..")) throw new AcceptError(`check path ${p} must be relative to the repo and inside it`);
    if (!existsSync(join(repo, p))) throw new AcceptError(`check path ${p} does not exist in ${repo}`);
    hashes[p] = sha256(readFileSync(join(repo, p)));
  }
  const ratification: Ratification = { card: cardId, verify: argv, checkPaths: paths, sha256: hashes };
  mkdirSync(join(repo, "checks"), { recursive: true });
  const file = join(repo, "checks", `${cardId}.json`);
  writeFileSync(file, JSON.stringify(ratification, null, 2) + "\n");
  appendEvent(root, "card.ratified", { ...ratification, file: `checks/${cardId}.json` });
  return { file, ratification };
}

export function resolveRef(ref: string, repo: string, exec: Exec): { sha: string; pr: number | null } {
  let target = ref;
  let pr: number | null = null;
  if (/^\d+$/.test(ref)) {
    pr = Number(ref);
    const view = exec(["gh", "pr", "view", ref, "--json", "headRefName,headRefOid"], repo);
    if (view.code !== 0) throw new AcceptError(`gh pr view ${ref} failed: ${view.stderr.trim().slice(0, 200)}`);
    let head: { headRefName?: string; headRefOid?: string };
    try { head = JSON.parse(view.stdout); } catch { throw new AcceptError(`gh pr view ${ref}: unparseable output`); }
    if (!head.headRefName || !head.headRefOid) throw new AcceptError(`gh pr view ${ref}: no head ref`);
    const fetch = exec(["git", "fetch", "origin", head.headRefName], repo);
    if (fetch.code !== 0) throw new AcceptError(`git fetch origin ${head.headRefName} failed: ${fetch.stderr.trim().slice(0, 200)}`);
    target = head.headRefOid;
  }
  const rev = exec(["git", "rev-parse", "--verify", "--quiet", `${target}^{commit}`], repo);
  if (rev.code !== 0) throw new AcceptError(`cannot resolve ref '${ref}' in ${repo}`);
  return { sha: rev.stdout.trim(), pr };
}

export async function acceptRef(opts: AcceptOptions): Promise<AcceptResult> {
  const exec = opts.exec ?? defaultExec;
  const repo = opts.repo ?? opts.root;
  const timeoutMs = opts.timeoutMs ?? 900_000;
  const cardDir = findCardDir(opts.root, opts.cardId);
  if (!cardDir) throw new AcceptError(`no card ${opts.cardId} in any column`);
  const card = parseCard(cardDir);
  const { sha, pr } = resolveRef(opts.ref, repo, exec);

  // The base: `main` unless told otherwise. Its tip, not the merge-base, so a
  // check ratified after the candidate branched still binds it.
  const baseName = opts.base ?? (exec(["git", "rev-parse", "--verify", "--quiet", "refs/heads/main"], repo).code === 0 ? "main" : null);
  let base: string | null = null;
  if (baseName) {
    const r = exec(["git", "rev-parse", "--verify", "--quiet", `${baseName}^{commit}`], repo);
    if (r.code !== 0) throw new AcceptError(`cannot resolve base '${baseName}' in ${repo}`);
    base = r.stdout.trim();
  }
  const atBase = (path: string): string | null => {
    if (!base) return null;
    const r = exec(["git", "show", `${base}:${path}`], repo);
    return r.code === 0 ? r.stdout : null;
  };
  // Project config from the base, never the candidate. No base: the repo's working tree.
  const cfgRaw = base ? atBase("bandit.json") : existsSync(join(repo, "bandit.json")) ? readFileSync(join(repo, "bandit.json"), "utf-8") : null;
  const cfg = cfgRaw === null ? {} : parseBanditJson(cfgRaw, base ? `bandit.json at ${baseName}` : "bandit.json");
  const gates = cfg.gates ?? projectGates(opts.root);
  const ratRaw = atBase(`checks/${opts.cardId}.json`);
  const rat = ratRaw === null ? null : parseRatification(ratRaw, `checks/${opts.cardId}.json at ${baseName}`);
  const verify = rat ? rat.verify : card.frontmatter.verify ? splitArgv(card.frontmatter.verify) : [];
  if (verify.length === 0) throw new AcceptError(`card ${opts.cardId} has no verify: — nothing the worker does not own to run`);

  const runs: GateRun[] = [];
  let complete = false;
  let verifyOutput: string | null = null;
  appendEvent(opts.root, "acceptance.started", { card: opts.cardId, ref: opts.ref, sha, repo, base, ratified: rat !== null });
  // Before any worktree: is a ratified check required, and does the diff touch what the judged may not edit?
  if (!rat && cfg.requireRatified) {
    runs.push({ name: "ratification", argv: [], exitCode: 1, durationMs: 0, output: `bandit.json requires a ratified check; no checks/${opts.cardId}.json at ${baseName ?? "(no base)"}` });
  } else if (base) {
    const argv = ["git", "diff", "--name-only", `${base}...${sha}`];
    const d = exec(argv, repo);
    if (d.code !== 0) throw new AcceptError(`git diff against base failed: ${d.stderr.trim().slice(0, 200)}`);
    const hits = protectedHits(d.stdout.split("\n").filter(Boolean), [...PROTECTED_PATHS, ...(cfg.protected ?? []), ...(rat?.checkPaths ?? [])]);
    if (hits.length) runs.push({ name: "protected-paths", argv, exitCode: 1, durationMs: 0, output: hits.join("\n") });
  }

  if (runs.length === 0) {
    const wt = mkdtempSync(join(tmpdir(), "bandit-accept-"));
    try {
      const add = exec(["git", "worktree", "add", "--detach", wt, sha], repo);
      if (add.code !== 0) throw new AcceptError(`git worktree add failed: ${add.stderr.trim().slice(0, 200)}`);
      let pinned = true;
      if (rat && base) {
        // Every check path comes from the base and must hash to what was ratified.
        const t0 = Date.now();
        const bad: string[] = [];
        for (const p of rat.checkPaths) {
          const co = exec(["git", "checkout", base, "--", p], wt);
          const actual = co.code === 0 && existsSync(join(wt, p)) ? sha256(readFileSync(join(wt, p))) : "missing";
          if (actual !== rat.sha256[p]) bad.push(`${p}: ratified ${rat.sha256[p].slice(0, 12)}, at base ${actual.slice(0, 12)}`);
        }
        runs.push({ name: "ratified-checks", argv: ["git", "checkout", base, "--", ...rat.checkPaths], exitCode: bad.length ? 1 : 0, durationMs: Date.now() - t0, output: bad.join("\n") || "every check path matches its ratified sha256" });
        pinned = bad.length === 0;
      }
      const all: [string, string[]][] = [
        ...(cfg.setup ?? []).map((g, i): [string, string[]] => [`setup-${i + 1}`, g]),
        ["verify", verify],
        ...gates.map((g, i): [string, string[]] => [`gate-${i + 1}`, g]),
      ];
      complete = pinned;
      for (const [name, argv] of pinned ? all : []) {
        const t0 = Date.now();
        const r = await runArgv(argv, wt, timeoutMs);
        const text = r.output.toString("utf-8");
        runs.push({ name, argv, exitCode: r.exitCode, durationMs: Date.now() - t0, output: packObservation(text, cardDir, `accept-${name}`, 4096).text });
        if (name === "verify") verifyOutput = text;
        if (r.exitCode !== 0) { complete = false; break; } // first failure decides
      }
    } finally {
      exec(["git", "worktree", "remove", "--force", wt], repo);
      rmSync(wt, { recursive: true, force: true });
    }
  }
  const passed = complete && runs.every((g) => g.exitCode === 0);
  let extra: Record<string, unknown> = {};
  if (opts.annotate && verifyOutput !== null) {
    try { extra = await opts.annotate({ card, verifyOutput }); } catch {}
  }
  appendEvent(opts.root, passed ? "acceptance.passed" : "acceptance.failed", { ...extra, card: opts.cardId, ref: opts.ref, sha, base, ratified: rat !== null, gates: runs });
  return { passed, sha, pr, gates: runs, ratified: rat !== null, base };
}
