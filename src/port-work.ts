// port-work.ts — the worker side of the harness-neutral port: take a card
// (next), hand its worktree back to the kernel judge (submit), or give it up
// (release). Reuses the loop's claim, worktree, judge and move; reimplements none.
// A taken card carries a lease (port.next) the loop honours; see heldByPort.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cardsIn, claimCard, findCardDir, latestClaim, moveCard, parseCard, self } from "./kernel/card";
import { appendEvent, readEvents } from "./kernel/log";
import { acceptRef, parseBanditJson, PROTECTED_PATHS } from "./kernel/judge";
import { discardWorktree, keepWorktree, openWorktree, worktreeOf } from "./isolation";

export class PortError extends Error { constructor(message: string, public code: 2 | 3 = 2) { super(message); } }
export type NextCard = {
  id: string; title: string; task: string; acceptance: string; context: string; verify: string | null;
  workDir: string; branch: string; base: string; protected: string[]; leaseUntil: string;
};
export type SubmitResult = { id: string; passed: boolean; sha: string; branch: string; gates: { name: string; exitCode: number }[]; ratified: boolean };

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function portProtected(repoDir: string): string[] {
  const out = [...PROTECTED_PATHS];
  const add = (p: string) => { if (!out.includes(p)) out.push(p); };
  try {
    for (const p of parseBanditJson(readFileSync(join(repoDir, "bandit.json"), "utf-8"), "bandit.json").protected ?? []) add(p);
  } catch {}
  let files: string[] = [];
  try { files = readdirSync(join(repoDir, "checks")).filter((f) => f.endsWith(".json")).sort(); } catch {}
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(repoDir, "checks", f), "utf-8"));
      if (Array.isArray(j?.checkPaths)) for (const p of j.checkPaths) if (typeof p === "string") add(p);
    } catch {}
  }
  return out;
}

export function portLease(root: string, id: string): { pid: number; startedAt: string; leaseUntil: string; base: string; workDir: string; branch: string } | null {
  const e = readEvents(root).filter((x) => x.type === "port.next" && x.card === id).pop();
  if (!e) return null;
  return { pid: Number(e.pid), startedAt: String(e.startedAt), leaseUntil: String(e.leaseUntil), base: String(e.base), workDir: String(e.workDir), branch: String(e.branch) };
}

const inProgress = (root: string, id: string): boolean => existsSync(join(root, ".bandit", "board", "in-progress", id, "card.md"));

// The lease when the card is in progress and its latest claim is the one the lease names.
function leaseIfMatching(root: string, id: string): ReturnType<typeof portLease> {
  if (!inProgress(root, id)) return null;
  const claim = latestClaim(root, id);
  const lease = portLease(root, id);
  return claim && lease && claim.pid === lease.pid && claim.startedAt === lease.startedAt ? lease : null;
}

export function heldByPort(root: string, id: string, now: number = Date.now()): boolean {
  const lease = leaseIfMatching(root, id);
  return lease !== null && Date.parse(lease.leaseUntil) > now;
}

const section = (body: string, name: string): string => {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
};

export function portNext(root: string, opts: { id?: string; leaseMin?: number } = {}): NextCard | null {
  const leaseMin = opts.leaseMin ?? 120;
  let ids: string[];
  if (opts.id !== undefined) {
    if (!existsSync(join(root, ".bandit", "board", "backlog", opts.id, "card.md"))) throw new PortError(`card ${opts.id} is not in backlog`);
    ids = [opts.id];
  } else {
    ids = cardsIn(root, "backlog").map((c) => c.id);
  }
  for (const id of ids) {
    if (!claimCard(root, id)) continue;
    let wt: ReturnType<typeof openWorktree>;
    try {
      wt = openWorktree(root, id);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      moveCard(root, id, "in-progress", "backlog");
      appendEvent(root, "port.released", { card: id, reason });
      throw new PortError(reason);
    }
    const leaseUntil = new Date(Date.now() + leaseMin * 60_000).toISOString();
    const { pid, startedAt } = self();
    appendEvent(root, "port.next", { card: id, workDir: wt.dir, branch: wt.branch, base: wt.base, holder: "port", pid, startedAt, leaseUntil });
    const card = parseCard(findCardDir(root, id)!);
    return {
      id, title: card.frontmatter.title || id,
      task: section(card.body, "Task"), acceptance: section(card.body, "Acceptance"), context: section(card.body, "Context"),
      verify: card.frontmatter.verify ?? null,
      workDir: wt.dir, branch: wt.branch, base: wt.base, protected: portProtected(root), leaseUntil,
    };
  }
  return null;
}

function heldOrThrow(root: string, id: string): NonNullable<ReturnType<typeof portLease>> {
  if (!findCardDir(root, id)) throw new PortError(`no card ${id}`);
  const lease = leaseIfMatching(root, id);
  if (!lease) throw new PortError(`card ${id} is not held by the port`);
  return lease;
}

export async function portSubmit(root: string, id: string, opts: { message?: string } = {}): Promise<SubmitResult> {
  const lease = heldOrThrow(root, id);
  const { dir, branch } = worktreeOf(root, id);
  if (!existsSync(dir)) throw new PortError(`no worktree for ${id}`);
  if (git(dir, "status", "--porcelain") === "" && git(dir, "rev-parse", "HEAD") === lease.base) throw new PortError("nothing to submit");

  const title = parseCard(findCardDir(root, id)!).frontmatter.title || id;
  const kept = keepWorktree(root, id, opts.message ?? `bandit: ${id} ${title}`);
  if (kept.error) throw new PortError(kept.error);
  const sha = git(root, "rev-parse", `refs/heads/${branch}`);

  let verdict: Awaited<ReturnType<typeof acceptRef>>;
  try {
    verdict = await acceptRef({ root, cardId: id, ref: branch, base: lease.base });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    moveCard(root, id, "in-progress", "review");
    appendEvent(root, "task.failed", { card: id, reason: "judge", branch, error });
    throw new PortError(error);
  }
  const to = verdict.passed ? "done" : "review";
  if (!moveCard(root, id, "in-progress", to)) {
    appendEvent(root, "card.claim_lost", { card: id, to });
    throw new PortError(`card ${id} left in-progress before it could move to ${to}`);
  }
  if (verdict.passed) appendEvent(root, "card.completed", { card: id, verdict: sha });
  else appendEvent(root, "task.failed", { card: id, reason: "judge", branch, sha, gates: verdict.gates.map(({ name, exitCode, argv }) => ({ name, exitCode, argv })) });
  return { id, passed: verdict.passed, sha, branch, gates: verdict.gates.map(({ name, exitCode }) => ({ name, exitCode })), ratified: verdict.ratified };
}

export function portRelease(root: string, id: string): void {
  heldOrThrow(root, id);
  const branch = discardWorktree(root, id);
  moveCard(root, id, "in-progress", "backlog");
  appendEvent(root, "port.released", { card: id, branch });
}
