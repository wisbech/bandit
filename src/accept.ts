// accept.ts — the acceptance desk: card in, ref in, verdict out. The worker
// is anything that produced a branch; the gate (card verify + project gates)
// is one it does not own. Runs in a throwaway worktree, never the caller's tree.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findCardDir, parseCard, packObservation, runArgv } from "./runner";
import { splitArgv } from "./verify";
import { askRoundGate, loadDecisionConfig, resolveDecisionPort, type DecisionPort } from "./decisions";
import { emit } from "./loop";

export type Exec = (argv: string[], cwd: string) => { code: number; stdout: string; stderr: string };

export interface AcceptOptions {
  root: string;    // board root (contains .bandit/)
  cardId: string;
  ref: string;     // branch | sha | PR number (digits only)
  repo?: string;   // git repo to check out from; defaults to root
  post?: boolean;  // PR comment with the verdict (PR refs only)
  port?: DecisionPort; // shadow questions; defaults to the configured port
  exec?: Exec;     // git/gh runner (tests stub gh); gates always run via runArgv
  timeoutMs?: number;
}

export interface GateRun { name: string; argv: string[]; exitCode: number; durationMs: number; output: string }

export interface AcceptResult {
  passed: boolean;
  sha: string;
  gates: GateRun[];
  shadow: { demonstrates: number | null; vacuous: number | null };
}

// Usage / resolution problems: the CLI maps these to exit 2, never to a verdict.
export class AcceptError extends Error {}

export const defaultExec: Exec = (argv, cwd) => {
  const p = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
};

function projectGates(root: string): string[][] {
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
  if (opts.post && !/^\d+$/.test(opts.ref)) throw new AcceptError("--post needs --ref <pr-number>");
  const { sha, pr } = resolveRef(opts.ref, repo, exec);

  const wt = mkdtempSync(join(tmpdir(), "bandit-accept-"));
  const runs: GateRun[] = [];
  let shadow: AcceptResult["shadow"] = { demonstrates: null, vacuous: null };
  emit("acceptance.started", { card: opts.cardId, ref: opts.ref, sha, repo });
  try {
    const add = exec(["git", "worktree", "add", "--detach", wt, sha], repo);
    if (add.code !== 0) throw new AcceptError(`git worktree add failed: ${add.stderr.trim().slice(0, 200)}`);
    const all: [string, string[]][] = [["verify", verify], ...gates.map((g, i): [string, string[]] => [`gate-${i + 1}`, g])];
    for (const [name, argv] of all) {
      const t0 = Date.now();
      const r = await runArgv(argv, wt, timeoutMs);
      const text = r.output.toString("utf-8");
      runs.push({ name, argv, exitCode: r.exitCode, durationMs: Date.now() - t0, output: packObservation(text, cardDir, `accept-${name}`, 4096).text });
      // Shadow: asked exactly as the loop asks, recorded only — never votes.
      if (name === "verify") {
        const acceptance = (card.body.match(/## Acceptance\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "").slice(0, 2000);
        const port = opts.port ?? resolveDecisionPort(loadDecisionConfig(opts.root));
        const a = await askRoundGate(port, { demonstrates: acceptance, verificationOutput: text.slice(0, 6000), verificationCommand: card.frontmatter.verify });
        shadow = { demonstrates: a.demonstrates, vacuous: a.vacuous };
      }
      if (r.exitCode !== 0) break; // first failure decides
    }
  } finally {
    exec(["git", "worktree", "remove", "--force", wt], repo);
    rmSync(wt, { recursive: true, force: true });
  }
  const passed = runs.length === 1 + gates.length && runs.every((g) => g.exitCode === 0);
  emit(passed ? "acceptance.passed" : "acceptance.failed", { card: opts.cardId, ref: opts.ref, sha, gates: runs, shadow });
  if (opts.post && pr !== null) {
    const rows = runs.map((g) => `| ${g.name} | \`${g.argv.join(" ")}\` | ${g.exitCode} | ${(g.durationMs / 1000).toFixed(1)}s |`);
    const body = [`**bandit accept** \`${opts.cardId}\` at \`${sha.slice(0, 12)}\`: **${passed ? "PASSED" : "FAILED"}**`, "", "| gate | argv | exit | time |", "|---|---|---|---|", ...rows].join("\n");
    const c = exec(["gh", "pr", "comment", String(pr), "--body", body], repo);
    if (c.code !== 0) emit("acceptance.post_failed", { card: opts.cardId, pr, reason: c.stderr.trim().slice(0, 200) });
  }
  return { passed, sha, gates: runs, shadow };
}
