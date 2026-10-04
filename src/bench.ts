import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLoop } from "./loop";
import { resolveTransport, defaultExec, findCardDir, parseCard } from "./runner";
import { readEvents } from "./kernel/log";
import { COLUMNS } from "./kernel/card";

// bench.ts — run a frozen board once in a throwaway project and report
// cost per judge-accepted card. The invoking project is never touched.

export interface BenchReport {
  cards: number;
  accepted: number;
  rounds: number;
  tokens: number;
  costPerAccepted: number | null;
  results: { id: string; accepted: boolean; rounds: number; tokens: number }[];
}

export async function runBench(home: string, boardDir: string): Promise<BenchReport> {
  const ids = readdirSync(boardDir).filter((n) => existsSync(join(boardDir, n, "card.md"))).sort();
  const cfg = JSON.parse(readFileSync(join(home, ".bandit", "config.json"), "utf-8"));
  const temp = mkdtempSync(join(tmpdir(), "bandit-bench-"));
  try {
    const git = (...argv: string[]) => {
      const r = defaultExec(["git", ...argv], temp);
      if (r.code !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
    };
    git("init", "-q", "-b", "main");
    writeFileSync(join(temp, ".gitignore"), ".bandit/\n");
    git("add", ".gitignore");
    git("-c", "user.name=bandit", "-c", "user.email=bandit@localhost", "commit", "-q", "-m", "bench");

    const bd = join(temp, ".bandit");
    for (const c of COLUMNS) mkdirSync(join(bd, "board", c), { recursive: true });
    mkdirSync(join(bd, "events"), { recursive: true });
    for (const id of ids) cpSync(join(boardDir, id), join(bd, "board", "backlog", id), { recursive: true });
    cpSync(join(home, ".bandit", "serfs"), join(bd, "serfs"), { recursive: true });
    if (existsSync(join(home, ".bandit", "harnesses"))) cpSync(join(home, ".bandit", "harnesses"), join(bd, "harnesses"), { recursive: true });
    const { transport, command, args, maxRetries } = cfg;
    writeFileSync(join(bd, "config.json"), JSON.stringify({ transport, command, args, maxRetries, isolation: "worktree" }, null, 2));

    process.chdir(temp);
    try {
      await runLoop({
        root: temp,
        transport: resolveTransport({ kind: cfg.transport ?? "headless", command: cfg.command ?? "opencode", args: cfg.args ?? ["run"] }, temp),
        maxRetries: cfg.maxRetries ?? 3,
        once: true,
      });
    } finally {
      process.chdir(home);
    }

    const events = readEvents(temp);
    const results = ids.map((id) => {
      const mine = events.filter((e) => e.card === id);
      const verdict = mine.filter((e) => e.type === "acceptance.passed" || e.type === "acceptance.failed").pop();
      const dir = findCardDir(temp, id);
      const tokens = dir ? Number(parseCard(dir).frontmatter.lifetimeTokensUsed ?? 0) || 0 : 0;
      return { id, accepted: verdict?.type === "acceptance.passed", rounds: mine.filter((e) => e.type === "round.started").length, tokens };
    });
    const accepted = results.filter((r) => r.accepted).length;
    const tokens = results.reduce((s, r) => s + r.tokens, 0);
    return {
      cards: results.length,
      accepted,
      rounds: results.reduce((s, r) => s + r.rounds, 0),
      tokens,
      costPerAccepted: accepted > 0 ? tokens / accepted : null,
      results,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
