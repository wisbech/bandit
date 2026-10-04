---
id: folder-router
title: The serf folders are the routing table
verify: bun test ./tests/seed/folder-router.check.ts
---
# The serf folders are the routing table

## Task
Two changes: a new `src/router.ts`, and one hook in `src/loop.ts`.

**1. Create `src/router.ts`** exporting exactly:

```ts
import type { DecisionPort } from "./decisions";
export function routeCandidates(root: string): Record<string, string>;
export async function routeCard(
  root: string,
  card: { id: string; title?: string; task?: string; frontmatter?: Record<string, string> },
  port: DecisionPort,
): Promise<{ serf: string; source: "card" | "choice" | "default"; probabilities?: Record<string, number> }>;
```

`routeCandidates(root)` returns serf name -> mission text:
- A candidate is every DIRECTORY `<root>/.bandit/serfs/<name>/` that contains BOTH `serf.md` and `prompt.md`, except `master` and `critic`. Plain files in `.bandit/serfs/` are ignored. No `.bandit/serfs/` folder: return `{}`.
- Mission text: in `serf.md`, find the line `## Mission`. Below it, skip blank lines; the mission is the following lines up to the first blank line or the first line starting with `#`, each line trimmed, joined with one space. If there is no `## Mission` line, or no text under it before the next heading, the mission is the folder name. Cut the result to its first 300 characters (`.slice(0, 300)`).

`routeCard(root, card, port)` applies these rules in order (candidates = `routeCandidates(root)`):
1. If `card.frontmatter?.serf` is the name of a candidate: return `{ serf: <that name>, source: "card" }`. Do not call the port.
2. If there are fewer than two candidates: return `{ serf: <the only candidate, or "actor" when there are none>, source: "default" }`. Do not call the port.
3. Call `port.choose(state, instructions, candidates)` once, where `state` is `` `${card.title ?? card.id}\n\n${card.task ?? ""}` `` (it must contain both the title and the task), `instructions` is a non-empty question such as `"Which serf's mission fits this card?"`, and the options are exactly the candidates map. Take the label with the highest probability. If that probability is `>= 0.5` and the label is a candidate: return `{ serf: <label>, source: "choice", probabilities: <the answer as returned> }`.
4. Otherwise (the answer is `null`, `port.choose` throws or rejects, the top probability is below 0.5, or the top label is not a candidate): return `{ serf: "actor", source: "default" }` (you may include `probabilities` when the port answered).

On rules 1 and 2 the result has no `probabilities` key. Every call of `routeCard` appends exactly one event through the kernel log: `appendEvent(root, "card.routed", { card: card.id, serf, source })`, plus `probabilities` when the result carries them (`import { appendEvent } from "./kernel/log"`).

**2. Wire it into the loop, opt-in.** In `src/loop.ts`, `convergeCard` starts with `const actorDir = join(dir("serfs"), "actor");`. Replace it so that when `<config.root>/.bandit/config.json` parses and has `"router": "folders"`, the actor folder is the routed serf's:

```ts
let actorDir = join(dir("serfs"), "actor");
// read config.root/.bandit/config.json (missing or bad JSON = router off)
if (routerOn) {
  const routed = await routeCard(config.root, {
    id: card.id, title: card.frontmatter.title, task: String(cardVars(card).task ?? ""), frontmatter: card.frontmatter,
  }, decisionPort ?? nullPort());
  actorDir = join(dir("serfs"), routed.serf);
}
```

(`cardVars` is exported from `src/runner.ts`, `nullPort` from `src/decisions.ts`; `decisionPort` is the module variable `runLoop` already sets.) `actorDir` is then used, unchanged, for the plan phase and every round. Without `"router": "folders"` the loop behaves exactly as today: the `actor` folder, no `card.routed` event, no `choose` call.

## Acceptance
- `routeCandidates` lists only folders with both `serf.md` and `prompt.md`, never `master` or `critic`, ignores plain files, and returns `{}` with no serfs folder.
- Missions: the first non-empty paragraph under `## Mission`, lines joined by one space; it stops at a blank line or the next heading; text before `## Mission` is ignored; no section or an empty one gives the folder name; at most 300 characters.
- Rule 1: `serf: tester` in the frontmatter routes to `tester` (source `card`) without calling the port, and wins before rule 2; a `serf:` that is not a candidate (e.g. `master`) is ignored.
- Rule 2: one candidate is returned, none gives `actor`, both with source `default`, port not called.
- Rule 3: `{actor: 0.2, tester: 0.7, docs: 0.1}` routes to `tester`, source `choice`, probabilities returned; exactly `0.5` is taken. The port is called once, with the candidates as options and the title and task in the state.
- Rule 4: below 0.5, `null`, a throwing port, or a top label that is not a candidate all give `actor`, source `default`.
- Each `routeCard` call logs exactly one `card.routed` with `card`, `serf`, `source` (and the probabilities on a choice).
- With `"router": "folders"` and a port that picks `tester`, `runLoop` sends `.bandit/serfs/tester/prompt.md` (not the actor's) to the worker and logs `card.routed`. Without it, the actor's prompt is used and nothing is routed.
- `bun test` and `bunx tsc --noEmit` stay green.

## Context
The owner's "folder as structure and router": a serf is a folder, so the set of serf folders and their `## Mission` sections is the routing table; the decision port's typed Choice picks among them the same way the routing consult picks a route (`routeDecision` and `ROUTE_MIN_P` in `src/loop.ts`, `DecisionPort.choose` in `src/decisions.ts`). Fail-closed: no evaluator, or an unsure one, means the `actor` folder, as today.
Note: the loop finds serf folders under `process.cwd()` (`dir()` in `src/loop.ts`) while the router reads `config.root`; in practice they are the same directory. Keep the loop's `dir("serfs")` for the actor path.
This card does not read `prompts/<serf>/prompt.md` (card `prompts-tracked`); a candidate needs `.bandit/serfs/<name>/prompt.md`.
The change is outside the kernel: new `src/router.ts`, and `src/loop.ts`.
Do not edit tests/seed/, scripts/seed/, checks/, src/kernel/, bandit.json, package.json, tsconfig.json — a change there is rejected by the judge.
