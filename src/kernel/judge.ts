// kernel/judge.ts — the acceptance verdict: card in, ref in, verdict out.
// The worker is anything that produced a branch; the gate (card verify +
// project gates) is one it does not own. Runs in a throwaway worktree, never
// the caller's tree. Deterministic: no model calls. Callers that want to
// record a model's opinion beside the verdict pass `annotate`; what it
// returns is logged with the verdict and can never change it.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  await Promise.race([pumps, new Promise((r) => setTimeout(r, 2_000))]);
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
  const verify = card.frontmatter.verify ? splitArgv(card.frontmatter.verify) : [];
  if (verify.length === 0) throw new AcceptError(`card ${opts.cardId} has no verify: — nothing the worker does not own to run`);
  const gates = projectGates(opts.root);
  const { sha, pr } = resolveRef(opts.ref, repo, exec);

  const wt = mkdtempSync(join(tmpdir(), "bandit-accept-"));
  const runs: GateRun[] = [];
  let verifyOutput: string | null = null;
  appendEvent(opts.root, "acceptance.started", { card: opts.cardId, ref: opts.ref, sha, repo });
  try {
    const add = exec(["git", "worktree", "add", "--detach", wt, sha], repo);
    if (add.code !== 0) throw new AcceptError(`git worktree add failed: ${add.stderr.trim().slice(0, 200)}`);
    const all: [string, string[]][] = [["verify", verify], ...gates.map((g, i): [string, string[]] => [`gate-${i + 1}`, g])];
    for (const [name, argv] of all) {
      const t0 = Date.now();
      const r = await runArgv(argv, wt, timeoutMs);
      const text = r.output.toString("utf-8");
      runs.push({ name, argv, exitCode: r.exitCode, durationMs: Date.now() - t0, output: packObservation(text, cardDir, `accept-${name}`, 4096).text });
      if (name === "verify") verifyOutput = text;
      if (r.exitCode !== 0) break; // first failure decides
    }
  } finally {
    exec(["git", "worktree", "remove", "--force", wt], repo);
    rmSync(wt, { recursive: true, force: true });
  }
  const passed = runs.length === 1 + gates.length && runs.every((g) => g.exitCode === 0);
  let extra: Record<string, unknown> = {};
  if (opts.annotate && verifyOutput !== null) {
    try { extra = await opts.annotate({ card, verifyOutput }); } catch {}
  }
  appendEvent(opts.root, passed ? "acceptance.passed" : "acceptance.failed", { ...extra, card: opts.cardId, ref: opts.ref, sha, gates: runs });
  return { passed, sha, pr, gates: runs };
}
