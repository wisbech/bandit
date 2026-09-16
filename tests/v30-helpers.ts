import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";

// Shared test helpers: seed the v3 scaffold in a temp project root.

export function seedDefaultFolders(root: string): void {
  mkdirSync(join(root, ".bandit", "board", "backlog"), { recursive: true });
  mkdirSync(join(root, ".bandit", "board", "in-progress"), { recursive: true });
  mkdirSync(join(root, ".bandit", "board", "done"), { recursive: true });
  mkdirSync(join(root, ".bandit", "board", "review"), { recursive: true });
  mkdirSync(join(root, ".bandit", "events"), { recursive: true });
  for (const name of ["master", "critic", "actor"]) {
    for (const sub of ["outputs", "journal", "memory", "children"]) {
      mkdirSync(join(root, ".bandit", "serfs", name, sub), { recursive: true });
    }
    writeFileSync(join(root, ".bandit", "serfs", name, "serf.md"), `# ${name}\n`);
    writeFileSync(join(root, ".bandit", "serfs", name, "state.md"), "# State\n");
  }
  writeFileSync(join(root, ".bandit", "serfs", "actor", "prompt.md"), `You are actor.

TASK: {{card.task}}
ACCEPTANCE:
{{card.acceptance}}

Report VERIFICATION_COMMAND, VERIFICATION_EXIT_CODE, VERIFICATION_OUTPUT.`);
  writeFileSync(join(root, ".bandit", "serfs", "critic", "prompt.md"), `Evaluate this output adversarially.

ACTOR OUTPUT:
{{actor.output}}

Respond:
VERDICT: pass | fail | uncertain
CONFIDENCE: 0.0 to 1.0
REASONING: [evidence]`);
}

// Emit an event into the project's event log (for replay tests).
export function appendTestEvent(root: string, type: string, payload: Record<string, unknown>): void {
  const date = new Date().toISOString().slice(0, 10);
  const eventsDir = join(root, ".bandit", "events");
  if (!existsSync(eventsDir)) mkdirSync(eventsDir, { recursive: true });
  writeFileSync(join(eventsDir, `${date}.jsonl`), JSON.stringify({ type, ts: new Date().toISOString(), ...payload }) + "\n", { flag: "a" });
}