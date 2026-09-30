import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { runLoop } from "../src/loop";
import { seedDefaultFolders } from "./v30-helpers";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// V3-4: the consult model — critic as the master's peer.
// Grading = classifier seat (no judge serf). Conversation = consult thread
// (card/consult.md) at plan time, stagnation, and no-convergence routing.
// The gate is untouched by any consult: no conversation turns a red gate green.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bandit-v34-"));
  process.chdir(root);
  seedDefaultFolders(root);
});

afterEach(() => {
  process.chdir("/");
  rmSync(root, { recursive: true, force: true });
});

function seedCard(id: string, body = "# card\n- works\n", extraFrontmatter = ""): string {
  const cardDir = join(root, ".bandit", "board", "backlog", id);
  mkdirSync(cardDir, { recursive: true });
  writeFileSync(join(cardDir, "card.md"), `---\ncolumn: backlog\nid: ${id}\n${extraFrontmatter}---\n# ${id}\n${body}`);
  return cardDir;
}

function writeStub(name: string, body: string): string {
  const p = join(root, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

// Standard stub: grader fails round 1, passes when the amended marker appears;
// consult replies end with a DECISION line.
const CONSULT_STUB = [
  "#!/bin/sh",
  'if echo "$1" | grep -q "Grade this output"; then',
  '  if echo "$1" | grep -q "CITED-EVIDENCE"; then echo "VERDICT: pass\\nCONFIDENCE: 0.9\\nREASONING: amended output cites evidence"; else echo "VERDICT: fail\\nCONFIDENCE: 0.9\\nREASONING: no evidence cited"; fi',
  "  exit 0",
  "fi",
  'case "$1" in',
  '  *"consult: plan"*) echo "The plan skips evidence collection.\\n\\nDECISION: amend";;',
  '  *"CONSULT (stagnation)"*) echo "The wall is the missing evidence step, not a capability gap.\\n\\nDECISION: amend";;',
  '  *"CONSULT (routing)"*) echo "Retry with the amended evidence step.\\n\\nDECISION: proceed";;',
  '  *) round=$(cat ${0%/*}/.fb-round 2>/dev/null || echo 0); round=$((round+1)); echo $round > ${0%/*}/.fb-round;',
  '     if [ "$round" -le 1 ]; then echo "attempt\\nVERIFICATION_COMMAND: false\\nVERIFICATION_EXIT_CODE: 1\\nVERIFICATION_OUTPUT: red"; else echo "amended: CITED-EVIDENCE\\nVERIFICATION_COMMAND: true\\nVERIFICATION_EXIT_CODE: 0\\nVERIFICATION_OUTPUT: 3 pass"; fi;;',
  "esac",
].join("\n");

describe("V3-4: consult model", () => {
  test("plan consult: critic amends the plan before execution, thread travels with the card", async () => {
    seedCard("consult-plan", `${"- refactor module ".repeat(20)}\n\n${Array.from({ length: 5 }, (_, i) => `- criterion ${i} is verifiable`).join("\n")}\n`);
    const transport = writeStub("stub-p.sh", CONSULT_STUB);
    const result = await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 2 });
    void result;
    const events = readFileSync(join(root, ".bandit", "events", new Date().toISOString().slice(0, 10) + ".jsonl"), "utf-8");
    expect(events).toContain("consult.opened");
    expect(events).toContain('"thread":"plan"');
    expect(events).toContain("consult.decided");
    // the thread lands in the card folder, wherever it now lives
    const cardDirs = ["backlog", "in-progress", "review", "done"].map((c) => join(root, ".bandit", "board", c, "consult-plan"));
    const found = cardDirs.find((d) => existsSync(join(d, "consult.md")));
    expect(found).toBeTruthy();
    const thread = readFileSync(join(found!, "consult.md"), "utf-8");
    expect(thread).toContain("DECISION: amend");
    expect(thread).toContain("**critic:**");
  });

  test("plan consult reject → back to author with the argument, zero execution rounds", async () => {
    seedCard("consult-reject", `${"- hard module ".repeat(30)}\n\n${Array.from({ length: 6 }, (_, i) => `- criterion ${i}`).join("\n")}\n`);
    const transport = writeStub("stub-rj.sh", [
      "#!/bin/sh",
      'if echo "$1" | grep -q "Grade this output"; then echo "VERDICT: pass\\nCONFIDENCE: 0.9\\nREASONING: ok"; exit 0; fi',
      'case "$1" in',
      '  *"consult: plan"*) echo "The plan is missing the verification command.\\n\\nDECISION: reject";;',
      '  *) echo "attempt\\nVERIFICATION_COMMAND: false\\nVERIFICATION_EXIT_CODE: 1\\nVERIFICATION_OUTPUT: red";;',
      "esac",
    ].join("\n"));
    const result = await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 2 });
    expect(result.completed).toBe(0);
    const events = readFileSync(join(root, ".bandit", "events", new Date().toISOString().slice(0, 10) + ".jsonl"), "utf-8");
    expect(events).toContain("plan.rejected");
    expect(events).toContain('"via":"consult"');
    // zero execution rounds — rejected at plan time
    expect(events).not.toContain("round.started");
  });

  test("stagnation consult fires on repeated failure; amended argument becomes feedback", async () => {
    seedCard("consult-stag");
    // Actor red both rounds with the SAME verification output (gate fingerprint
    // repeats) — round 2 must open the stagnation consult, and the consult's
    // amend verdict must become round-3 feedback. maxRetries 3 gives room.
    const transport = writeStub("stub-s.sh", [
      "#!/bin/sh",
      'if echo "$1" | grep -q "Grade this output"; then echo "VERDICT: fail\\nCONFIDENCE: 0.9\\nREASONING: no evidence cited"; exit 0; fi',
      'case "$1" in',
      '  *"CONSULT (stagnation)"*) echo "The wall is the missing evidence step, not a capability gap.\\n\\nDECISION: amend";;',
      '  *"CONSULT (routing)"*) echo "Retry.\\n\\nDECISION: proceed";;',
      '  *) echo "attempt\\nVERIFICATION_COMMAND: false\\nVERIFICATION_EXIT_CODE: 1\\nVERIFICATION_OUTPUT: FAIL: expected 3 got 2";;',
      "esac",
    ].join("\n"));
    await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 3 });
    const events = readFileSync(join(root, ".bandit", "events", new Date().toISOString().slice(0, 10) + ".jsonl"), "utf-8");
    expect(events).toContain('"thread":"stagnation"');
    expect(events).toContain("consult.turn");
    // exactly one stagnation consult despite 3 rounds
    expect((events.match(/"type":"consult.opened"[^\n]*"thread":"stagnation"/g) ?? []).length).toBe(1);
  });

  test("routing consult at no-convergence: DECISION specialist spawns with the critic-named capability", async () => {
    seedCard("consult-route");
    const transport = writeStub("stub-rt.sh", [
      "#!/bin/sh",
      'if echo "$1" | grep -q "Grade this output"; then echo "VERDICT: fail\\nCONFIDENCE: 0.9\\nREASONING: missing: evidence file"; exit 0; fi',
      'case "$1" in',
      '  *"consult: plan"*) echo "Fine.\\n\\nDECISION: proceed";;',
      '  *"CONSULT (stagnation)"*) echo "Capability gap: evidence pipeline.\\n\\nDECISION: amend";;',
      '  *"CONSULT (routing)"*) echo "The actor cannot learn this mid-card: specialist: evidence-pipeline\\n\\nDECISION: specialist";;',
      '  *) echo "attempt\\nVERIFICATION_COMMAND: false\\nVERIFICATION_EXIT_CODE: 1\\nVERIFICATION_OUTPUT: red";;',
      "esac",
    ].join("\n"));
    await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 2 });
    const events = readFileSync(join(root, ".bandit", "events", new Date().toISOString().slice(0, 10) + ".jsonl"), "utf-8");
    expect(events).toContain("consult.routed");
    expect(events).toContain('"decision":"specialist"');
    expect(events).toContain("specialist.spawned");
    expect(events).toContain("evidence-pipeline");
  });

  test("pass verdict triggers no consult; grading track record still lands", async () => {
    seedCard("consult-pass", undefined, "verify: true\n");
    const p = writeStub("stub-g.sh", "#!/bin/sh\ncat << 'OUT'\nDid the work.\nVERIFICATION_COMMAND: true\nVERIFICATION_EXIT_CODE: 0\nVERIFICATION_OUTPUT: 3 pass\nOUT\n");
    await runLoop({ once: true, root, transport: { kind: "headless", command: p, args: [] }, maxRetries: 1 });
    const events = readFileSync(join(root, ".bandit", "events", new Date().toISOString().slice(0, 10) + ".jsonl"), "utf-8");
    expect(events).not.toContain("consult.opened");
    expect(events).toContain("card.completed");
    expect(existsSync(join(root, ".bandit", "grading", "consult-pass.md"))).toBe(true);
  });

  test("consult cannot turn a red gate green", async () => {
    seedCard("consult-gate", undefined, "verify: false\n");
    const transport = writeStub("stub-gr.sh", [
      "#!/bin/sh",
      'if echo "$1" | grep -q "Grade this output"; then echo "VERDICT: pass\\nCONFIDENCE: 0.9\\nREASONING: grader passed"; exit 0; fi',
      'case "$1" in',
      '  *"consult: plan"*) echo "Fine.\\n\\nDECISION: proceed";;',
      '  *"CONSULT (stagnation)"*) echo "All good, proceed.\\n\\nDECISION: proceed";;',
      '  *) echo "attempt\\nVERIFICATION_COMMAND: false\\nVERIFICATION_EXIT_CODE: 1\\nVERIFICATION_OUTPUT: red";;',
      "esac",
    ].join("\n"));
    const result = await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 1 });
    // grader passed, consult passed, gate red → task.failed. No conversation moves the gate.
    expect(result.completed).toBe(0);
    const events = readFileSync(join(root, ".bandit", "events", new Date().toISOString().slice(0, 10) + ".jsonl"), "utf-8");
    expect(events).toContain("task.failed");
    expect(events).toContain('"type":"verification.red"');
    expect(events).not.toContain("converged");
  });

  test("master route amend → card requeued to backlog, zero manual fixes (bounded)", async () => {
    seedCard("consult-amend");
    const transport = writeStub("stub-am.sh", [
      "#!/bin/sh",
      'if echo "$1" | grep -q "Grade this output"; then echo "VERDICT: fail\\nCONFIDENCE: 0.9\\nREASONING: no evidence cited"; exit 0; fi',
      'case "$1" in',
      '  *"CONSULT (routing)"*) echo "Amend the plan and retry.\\n\\nDECISION: amend";;',
      '  *) echo "attempt\\nVERIFICATION_COMMAND: false\\nVERIFICATION_EXIT_CODE: 1\\nVERIFICATION_OUTPUT: red";;',
      "esac",
    ].join("\n"));
    const result = await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 1 });
    // Not failed, not completed: the routing consult's amend requeues the card.
    expect(result.completed).toBe(0);
    const events = readFileSync(join(root, ".bandit", "events", new Date().toISOString().slice(0, 10) + ".jsonl"), "utf-8");
    expect(events).toContain("consult.routed");
    expect(events).toContain('"decision":"amend"');
    expect(events).toContain("card.requeued");
    expect(events).not.toContain('"type":"task.failed"[^\\n]*consult-amend');
    const cardDir = join(root, ".bandit", "board", "backlog", "consult-amend");
    expect(existsSync(cardDir)).toBe(true);
    const cardRaw = readFileSync(join(cardDir, "card.md"), "utf-8");
    expect(cardRaw).toContain("amendRequeues: 1");
    // Second pass: the loop re-drains the requeued card from backlog with no human move.
    const second = await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 1 });
    expect(second.processed).toBe(1);
    expect(readFileSync(join(cardDir, "card.md"), "utf-8")).toContain("amendRequeues: 2");
    // Bound: at the limit, the third amend route leaves it in review for a human.
    const third = await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 1 });
    expect(events + readFileSync(join(root, ".bandit", "events", new Date().toISOString().slice(0, 10) + ".jsonl"), "utf-8")).toContain("card.amend_limit");
    expect(existsSync(join(root, ".bandit", "board", "review", "consult-amend"))).toBe(true);
    void third;
  });
});