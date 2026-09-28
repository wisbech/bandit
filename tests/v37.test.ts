import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { runLoop, parseCriticVerdict } from "../src/loop";
import { selfVerifyGateAsync, parseGate, containerStage, type GateResult } from "../src/runner";
import { seedDefaultFolders } from "./v30-helpers";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// V3-7: the three earned unfreezes —
// 1. the seat reads the consult thread (thread-lived criteria are gradable) + per-criterion CRITERIA lines
// 2. routing consult captures the specialist capability from the DECISION line itself
// 3. verificationContainer is enforced — self-verify wraps in docker exec when declared

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bandit-v37-"));
  process.chdir(root);
  seedDefaultFolders(root);
});

afterEach(() => {
  process.chdir("/");
  rmSync(root, { recursive: true, force: true });
});

function seedCard(id: string, body = "# card\n- works\n"): string {
  const cardDir = join(root, ".bandit", "board", "backlog", id);
  mkdirSync(cardDir, { recursive: true });
  writeFileSync(join(cardDir, "card.md"), `---\ncolumn: backlog\nid: ${id}\ntitle: ${id}\n---\n# ${id}\n${body}`);
  return cardDir;
}

function writeStub(name: string, body: string): string {
  const p = join(root, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

describe("V3-7: thread-visible seat", () => {
  test("grader reads consult.md — a criterion satisfied in-thread grades pass", async () => {
    seedCard("thread-graded");
    // write a consult thread into the card folder BEFORE the loop runs
    const cardDir = join(root, ".bandit", "board", "backlog", "thread-graded");
    writeFileSync(join(cardDir, "consult.md"), "# Consult thread\n\n**probe-quants:**\n\nThe quant voice confirmed: the criterion is satisfied — evidence file exists at docs/evidence.md.\n\n");
    // grader stub: PASSES when the prompt carries the consult thread
    const transport = writeStub("stub-tg.sh", [
      "#!/bin/sh",
      'if echo "$1" | grep -q "CONSULT THREAD"; then printf %b "CRITERIA:\\n- 1: pass — thread evidence\\nVERDICT: pass\\nCONFIDENCE: 0.9\\nREASONING: in-thread evidence\\n"; else echo "work done\\nVERIFICATION_COMMAND: true\\nVERIFICATION_EXIT_CODE: 0\\nVERIFICATION_OUTPUT: ok"; fi',
    ].join("\n"));
    const result = await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 1 });
    expect(result.completed).toBe(1);
    const grading = readFileSync(join(root, ".bandit", "grading", "thread-graded.md"), "utf-8");
    expect(grading).toContain("CRITERIA:");
    expect(grading).toContain("in-thread evidence");
  });

  test("critic.verdict events carry criteriaLines (the calibration data point)", async () => {
    seedCard("calibrated");
    const transport = writeStub("stub-cl.sh", [
      "#!/bin/sh",
      'if echo "$1" | grep -q "Grade the work"; then printf %b "CRITERIA:\\n- 1: pass — works\\n- 2: pass — verified\\nVERDICT: pass\\nCONFIDENCE: 0.9\\nREASONING: both criteria\\n"; else echo "work done\\nVERIFICATION_COMMAND: true\\nVERIFICATION_EXIT_CODE: 0\\nVERIFICATION_OUTPUT: ok"; fi',
    ].join("\n"));
    await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 1 });
    const events = readFileSync(join(root, ".bandit", "events", new Date().toISOString().slice(0, 10) + ".jsonl"), "utf-8");
    expect(events).toContain('"criteriaLines":2');
  });
});

describe("V3-7: specialist capability capture", () => {
  test("DECISION: specialist: <capability> inline form is parsed (no more unknown)", async () => {
    seedCard("cap-capture");
    const transport = writeStub("stub-cap.sh", [
      "#!/bin/sh",
      'if echo "$1" | grep -q "Grade the work"; then echo "VERDICT: fail\\nCONFIDENCE: 0.9\\nREASONING: cannot verify"; exit 0; fi',
      'case "$1" in',
      '  *"CONSULT (routing)"*) echo "Needs a real evidence pipeline.\\n\\nDECISION: specialist: evidence-pipeline";;',
      '  *) echo "work\\nVERIFICATION_COMMAND: false\\nVERIFICATION_EXIT_CODE: 1\\nVERIFICATION_OUTPUT: red";;',
      "esac",
    ].join("\n"));
    await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 1 });
    const events = readFileSync(join(root, ".bandit", "events", new Date().toISOString().slice(0, 10) + ".jsonl"), "utf-8");
    expect(events).toContain("specialist.spawned");
    expect(events).toContain("evidence-pipeline");
    expect(events).not.toContain("specialist-unknown-");
  });
});

describe("V3-7: container enforcement", () => {
  test("selfVerifyGateAsync wraps the command in docker exec when container is declared", async () => {
    seedCard("container-card");
    // No PATH shadowing (Bun.spawn snapshots env at startup) — use the real
    // docker error as the proof: the verify log must show the wrapped form
    // (docker exec <container> sh -c 'bun test') and the flag must be set.
    const cardDir = join(root, ".bandit", "board", "backlog", "container-card");
    const gate: GateResult = { green: false, command: "echo container-ran", exitCode: 1, fingerprint: "x", inContainer: false };
    const r = await selfVerifyGateAsync(gate, cardDir, 10_000, "tradingroom-dev");
    expect(r.attempted).toBe(true);
    expect(r.container).toBe(true);
    // The log carries the inner command's OUTPUT — "container-ran" could only
    // come from inside tradingroom-dev via the docker-exec wrap. The wrap
    // itself is asserted by containerStage's unit test above; this is the
    // end-to-end proof (flag + effect).
    const log = existsSync(join(cardDir, "verification-output.log")) ? readFileSync(join(cardDir, "verification-output.log"), "utf-8") : "";
    expect(log).toContain("container-ran");
  });

  test("no container declared → command runs bare (container flag false)", async () => {
    seedCard("bare-card");
    const gate: GateResult = { green: false, command: "true", exitCode: 1, inContainer: false };
    const cardDir = join(root, ".bandit", "board", "backlog", "bare-card");
    const r = await selfVerifyGateAsync(gate, cardDir, 10_000);
    expect(r.container ?? false).toBe(false);
    expect(r.actualExitCode).toBe(0);
  });

  test("containerStage composes docker exec sh -c form", () => {
    const wrapped = containerStage("bun test", "factory-container");
    expect(wrapped).toContain("docker exec factory-container sh -c");
    expect(wrapped).toContain("bun test");
    // idempotent
    expect(containerStage(wrapped, "factory-container")).toBe(wrapped);
  });

  test("gate.green flips on the container-run actual exit code", () => {
    const g = parseGate("VERIFICATION_COMMAND: `bun test`\nVERIFICATION_EXIT_CODE: 0\nVERIFICATION_OUTPUT: pass");
    expect(g.command).toBe("bun test"); // backticks stripped (the false-red fix)
    expect(g.green).toBe(true);
  });
});
