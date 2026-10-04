// router.ts — the serf folders are the routing table. A serf is a folder
// under .bandit/serfs/ holding serf.md and prompt.md; its `## Mission`
// paragraph is the option the decision port chooses among. Fail-closed:
// no evaluator, or an unsure one, means the `actor` folder.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DecisionPort } from "./decisions";
import { appendEvent } from "./kernel/log";

const EXCLUDED = new Set(["master", "critic"]);
const MIN_P = 0.5;

function mission(serfMd: string, name: string): string {
  const lines = serfMd.split("\n");
  let i = lines.findIndex((l) => l.trim() === "## Mission");
  if (i < 0) return name;
  i++;
  while (i < lines.length && lines[i].trim() === "") i++;
  const para: string[] = [];
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l === "" || l.startsWith("#")) break;
    para.push(l);
  }
  return (para.join(" ") || name).slice(0, 300);
}

export function routeCandidates(root: string): Record<string, string> {
  const base = join(root, ".bandit", "serfs");
  if (!existsSync(base)) return {};
  const out: Record<string, string> = {};
  for (const name of readdirSync(base).sort()) {
    if (EXCLUDED.has(name)) continue;
    const d = join(base, name);
    if (!statSync(d).isDirectory()) continue;
    if (!existsSync(join(d, "serf.md")) || !existsSync(join(d, "prompt.md"))) continue;
    out[name] = mission(readFileSync(join(d, "serf.md"), "utf-8"), name);
  }
  return out;
}

type Routed = { serf: string; source: "card" | "choice" | "default"; probabilities?: Record<string, number> };

async function decide(
  candidates: Record<string, string>,
  card: { id: string; title?: string; task?: string; frontmatter?: Record<string, string> },
  port: DecisionPort,
): Promise<Routed> {
  const named = card.frontmatter?.serf;
  if (named && Object.hasOwn(candidates, named)) return { serf: named, source: "card" };
  const names = Object.keys(candidates);
  if (names.length < 2) return { serf: names[0] ?? "actor", source: "default" };
  let answer: Record<string, number> | null = null;
  try {
    answer = await port.choose(
      `${card.title ?? card.id}\n\n${card.task ?? ""}`,
      "Which serf's mission fits this card?",
      candidates,
    );
  } catch {
    answer = null;
  }
  if (!answer) return { serf: "actor", source: "default" };
  let top: string | null = null;
  for (const [label, p] of Object.entries(answer)) if (top === null || p > answer[top]) top = label;
  if (top !== null && answer[top] >= MIN_P && Object.hasOwn(candidates, top)) {
    return { serf: top, source: "choice", probabilities: answer };
  }
  return { serf: "actor", source: "default", probabilities: answer };
}

export async function routeCard(
  root: string,
  card: { id: string; title?: string; task?: string; frontmatter?: Record<string, string> },
  port: DecisionPort,
): Promise<Routed> {
  const r = await decide(routeCandidates(root), card, port);
  appendEvent(root, "card.routed", { card: card.id, ...r });
  return r;
}
