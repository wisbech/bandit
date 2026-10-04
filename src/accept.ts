// accept.ts — the acceptance desk: the kernel judge (src/kernel/judge.ts),
// plus a shadow reading from the decision port logged beside the verdict,
// plus --post (a PR comment with the verdict). The verdict itself is the
// judge's alone; the shadow is recorded only and never votes.

import {
  acceptRef as judge, AcceptError, defaultExec, resolveRef,
  type AcceptOptions as JudgeOptions, type AcceptResult as Verdict, type Exec, type GateRun,
} from "./kernel/judge";
import { askRoundGate, loadDecisionConfig, resolveDecisionPort, type DecisionPort } from "./decisions";
import { appendEvent } from "./kernel/log";

export { AcceptError, defaultExec, resolveRef, type Exec, type GateRun };

export interface AcceptOptions extends Omit<JudgeOptions, "annotate"> {
  post?: boolean;      // PR comment with the verdict (PR refs only)
  port?: DecisionPort; // shadow questions; defaults to the configured port
}

export interface AcceptResult extends Verdict {
  shadow: { demonstrates: number | null; vacuous: number | null };
}

export async function acceptRef(opts: AcceptOptions): Promise<AcceptResult> {
  const exec = opts.exec ?? defaultExec;
  if (opts.post && !/^\d+$/.test(opts.ref)) throw new AcceptError("--post needs --ref <pr-number>");
  let shadow: AcceptResult["shadow"] = { demonstrates: null, vacuous: null };
  const verdict = await judge({
    ...opts,
    // Shadow: asked exactly as the loop asks, recorded only — never votes.
    annotate: async ({ card, verifyOutput }) => {
      const acceptance = (card.body.match(/## Acceptance\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "").slice(0, 2000);
      const port = opts.port ?? resolveDecisionPort(loadDecisionConfig(opts.root));
      const a = await askRoundGate(port, { demonstrates: acceptance, verificationOutput: verifyOutput.slice(0, 6000), verificationCommand: card.frontmatter.verify });
      shadow = { demonstrates: a.demonstrates, vacuous: a.vacuous };
      return { shadow };
    },
  });
  const { passed, sha, pr, gates: runs } = verdict;
  if (opts.post && pr !== null) {
    const rows = runs.map((g) => `| ${g.name} | \`${g.argv.join(" ")}\` | ${g.exitCode} | ${(g.durationMs / 1000).toFixed(1)}s |`);
    const body = [`**bandit accept** \`${opts.cardId}\` at \`${sha.slice(0, 12)}\`: **${passed ? "PASSED" : "FAILED"}**`, "", "| gate | argv | exit | time |", "|---|---|---|---|", ...rows].join("\n");
    const c = exec(["gh", "pr", "comment", String(pr), "--body", body], opts.repo ?? opts.root);
    if (c.code !== 0) appendEvent(opts.root, "acceptance.post_failed", { card: opts.cardId, pr, reason: c.stderr.trim().slice(0, 200) });
  }
  return { ...verdict, shadow };
}
