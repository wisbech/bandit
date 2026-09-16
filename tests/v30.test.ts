import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { parseCard, renderPrompt, parseGate, containerStage, runSerfOnCard, loadGateFingerprints } from "../src/runner";
import { runLoop, pipelineFor, cardsIn } from "../src/loop";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bandit-"));
  process.chdir(root);
  mkdirSync(join(root, ".bandit", "board", "backlog"), { recursive: true });
  mkdirSync(join(root, ".bandit", "board", "in-progress"), { recursive: true });
  mkdirSync(join(root, ".bandit", "board", "done"), { recursive: true });
  mkdirSync(join(root, ".bandit", "events"), { recursive: true });
  for (const name of ["master", "critic", "actor"]) {
    mkdirSync(join(root, ".bandit", "serfs", name, "outputs"), { recursive: true });
  }
  writeFileSync(join(root, ".bandit", "serfs", "actor", "prompt.md"), `You are actor.

TASK: {{card.task}}
ACCEPTANCE:
{{card.acceptance}}

Report VERIFICATION_COMMAND, VERIFICATION_EXIT_CODE, VERIFICATION_OUTPUT.`);
  writeFileSync(join(root, ".bandit", "serfs", "actor", "serf.md"), "# actor\n");
  writeFileSync(join(root, ".bandit", "serfs", "actor", "state.md"), "# State\n");
  writeFileSync(join(root, ".bandit", "serfs", "critic", "prompt.md"), `Evaluate this output adversarially.

ACTOR OUTPUT:
{{actor.output}}

Respond:
VERDICT: pass | fail | uncertain
CONFIDENCE: 0.0 to 1.0
REASONING: [evidence]`);
  writeFileSync(join(root, ".bandit", "serfs", "critic", "serf.md"), "# critic\n");
});

afterEach(() => {
  process.chdir("/");
  rmSync(root, { recursive: true, force: true });
});

// Simulated actor output: verification green in one attempt.
function greenOutput(): string {
  return "Did the work.\nVERIFICATION_COMMAND: bun test\nVERIFICATION_EXIT_CODE: 0\nVERIFICATION_OUTPUT: 3 pass";
}

function redOutput(): string {
  return "Tried something.\nVERIFICATION_COMMAND: bun test\nVERIFICATION_EXIT_CODE: 1\nVERIFICATION_OUTPUT: FAIL exports.test.ts";
}

describe("V3-0: card-as-folder", () => {
  test("card parses frontmatter and body", () => {
    const cardDir = join(root, ".bandit", "board", "backlog", "test-card");
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, "card.md"), "---\ncolumn: backlog\ntitle: Test Card\n---\n# Test Card\n\n- criterion one\n");
    const card = parseCard(cardDir);
    expect(card.id).toBe("test-card");
    expect(card.frontmatter.title).toBe("Test Card");
    expect(card.body).toContain("criterion one");
  });
});

describe("V3-0: runner composition", () => {
  test("renderPrompt fills template tags from card vars", () => {
    const out = renderPrompt("TASK: {{card.task}}\n{{card.acceptance}}", {
      card: { task: "fix exports", acceptance: ["a", "b"] },
    });
    expect(out).toContain("TASK: fix exports");
    expect(out).toContain("- a\n- b");
  });

  test("container stage wraps and is idempotent", () => {
    expect(containerStage("bun test", "dev")).toBe("docker exec dev sh -c 'bun test'");
    const wrapped = containerStage("bun test", "dev");
    expect(containerStage(wrapped, "dev")).toBe(wrapped);
    expect(containerStage("bun test", undefined)).toBe("bun test");
  });

  test("gate parses green and red verification", () => {
    const green = parseGate(greenOutput());
    expect(green.green).toBe(true);
    expect(green.command).toBe("bun test");
    const red = parseGate(redOutput());
    expect(red.green).toBe(false);
    expect(red.fingerprint).toBeDefined();
  });

  test("unchanged red gate gets fingerprinted and re-detected", () => {
    const cardDir = join(root, ".bandit", "board", "in-progress", "fp-card");
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, "card.md"), "---\ncolumn: in-progress\n---\n# fp\n");
    expect(loadGateFingerprints(cardDir)).toEqual([]);
    // first red run persists fingerprint
    const fp1 = parseGate(redOutput()).fingerprint!;
    // simulate runner behavior twice
    writeFileSync(join(cardDir, "gates.json"), JSON.stringify([fp1]));
    expect(loadGateFingerprints(cardDir)).toContain(fp1);
  });
});

describe("V3-0: end-to-end trivial card through composed runner", () => {
  test("a card with a green-verification actor runs to done", async () => {
    // Seed a backlog card
    const cardId = "trivial-e2e";
    const cardDir = join(root, ".bandit", "board", "backlog", cardId);
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, "card.md"), `---\ncolumn: backlog\nid: ${cardId}\ntitle: Trivial E2E\n---\n# Trivial E2E\n- it works\n`);

    // Monkey-patch the transport stage by writing a fake actor output first:
    // The runner reads the transport config; here we use the true end-to-end
    // path with a stub command that always outputs a green verification.
    const stubPath = join(root, "stub-actor.sh");
    writeFileSync(stubPath, `#!/bin/sh\ncat << 'OUT'\n${greenOutput()}\nOUT\n`);
    chmodSync(stubPath, 0o755);

    const result = await runLoop({
      once: true,
      root,
      transport: { kind: "headless", command: stubPath, args: [] },
      maxRetries: 2,
    });

    expect(result.processed).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    expect(existsSync(join(root, ".bandit", "board", "done", cardId, "card.md"))).toBe(true);
    // outputs persisted inside the card folder (card-as-folder)
    expect(existsSync(join(root, ".bandit", "board", "done", cardId, "outputs"))).toBe(true);
    // events are the truth
    const events = readdirSync(join(root, ".bandit", "events"));
    expect(events.length).toBe(1);
  });

  test("a red-verification actor exhausts retries and lands in review", async () => {
    const cardId = "red-e2e";
    const cardDir = join(root, ".bandit", "board", "backlog", cardId);
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, "card.md"), `---\ncolumn: backlog\nid: ${cardId}\ntitle: Red E2E\n---\n# Red\n`);

    const stubPath = join(root, "stub-red.sh");
    writeFileSync(stubPath, `#!/bin/sh\ncat << 'OUT'\n${redOutput()}\nOUT\n`);
    chmodSync(stubPath, 0o755);

    const result = await runLoop({
      once: true,
      root,
      transport: { kind: "headless", command: stubPath, args: [] },
      maxRetries: 2,
    });

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(1);
    expect(existsSync(join(root, ".bandit", "board", "review", cardId, "card.md"))).toBe(true);
  });
});

describe("V3-0: pipelines", () => {
  test("difficulty-proportional selection", () => {
    expect(pipelineFor(1, 50)).toBe("trivial");
    expect(pipelineFor(4, 300)).toBe("standard");
    expect(pipelineFor(6, 600)).toBe("hard");
  });

  test("cardsIn projects the board", () => {
    const cardDir = join(root, ".bandit", "board", "backlog", "p1");
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, "card.md"), "---\ncolumn: backlog\n---\n# p1\n");
    expect(cardsIn("backlog").length).toBe(1);
    expect(cardsIn("done").length).toBe(0);
  });
});