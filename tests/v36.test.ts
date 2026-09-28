import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { runLoop } from "../src/loop";
import { parseSummon } from "../src/loop";
import { seedDefaultFolders } from "./v30-helpers";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// V3-6: the summoned voice — SUMMON: <role> inside a consult reply brings one
// domain serf into the thread (child folder + registry), its reply folds into
// consult.md, the critic re-weighs, and the master decides on the whole thread.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bandit-v36-"));
  process.chdir(root);
  seedDefaultFolders(root);
  // summonable roles (init writes these in production; tests seed directly)
  mkdirSync(join(root, ".bandit", "serfs", "researcher"), { recursive: true });
  writeFileSync(join(root, ".bandit", "serfs", "researcher", "prompt.md"), "You are researcher. Cite sources; mark unverified claims.\n");
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

// Stub: grader passes when amended marker present; critic summons researcher;
// researcher answers; critic re-weighs to amend; actor red once then green.
const SUMMON_STUB = [
  "#!/bin/sh",
  'if echo "$1" | grep -q "Grade this output"; then',
  '  if echo "$1" | grep -q "CITED-EVIDENCE"; then echo "VERDICT: pass\\nCONFIDENCE: 0.9\\nREASONING: amended output cites evidence"; else echo "VERDICT: fail\\nCONFIDENCE: 0.9\\nREASONING: no evidence cited"; fi',
  "  exit 0",
  "fi",
  'case "$1" in',
  '  *"re-weigh"*) echo "The researcher\'s citation standard settles it.\\n\\nDECISION: amend";;',
  '  *"SUMMONED VOICE"*|*"You are researcher"*) echo "Per the bandit literature, divergence monitoring is required.\\n\\nCLAIM: cite Karwowski et al. 2023.";;',
  '  *"consult: plan"*) echo "The plan lacks a divergence monitor.\\n\\nSUMMON: researcher\\n\\nDECISION: amend";;',
  '  *"CONSULT (routing)"*) echo "Retry.\\n\\nDECISION: proceed";;',
  '  *) round=$(cat ${0%/*}/.fb-round 2>/dev/null || echo 0); round=$((round+1)); echo $round > ${0%/*}/.fb-round;',
  '     if [ "$round" -le 1 ]; then echo "attempt\\nVERIFICATION_COMMAND: false\\nVERIFICATION_EXIT_CODE: 1\\nVERIFICATION_OUTPUT: red"; else echo "amended: CITED-EVIDENCE\\nVERIFICATION_COMMAND: true\\nVERIFICATION_EXIT_CODE: 0\\nVERIFICATION_OUTPUT: 3 pass"; fi;;',
  "esac",
].join("\n");

describe("V3-6: summoned voices", () => {
  test("plan consult SUMMON spawns child serf, folds reply into thread, re-weighs", async () => {
    seedCard("summon-card", `${"- build module ".repeat(20)}\n\n${Array.from({ length: 5 }, (_, i) => `- criterion ${i} is verifiable`).join("\n")}\n`);
    const transport = writeStub("stub-sum.sh", SUMMON_STUB);
    await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 2 });
    const events = readFileSync(join(root, ".bandit", "events", new Date().toISOString().slice(0, 10) + ".jsonl"), "utf-8");
    expect(events).toContain("consult.summoned");
    expect(events).toContain('"role":"researcher"');
    expect(events).toContain("consult.reweighed");
    // child serf folder + registry entry exist (the audit)
    const childDirs = readdirSync(join(root, ".bandit", "serfs")).filter((n) => n.startsWith("researcher-consult-"));
    expect(childDirs.length).toBe(1);
    expect(existsSync(join(root, ".bandit", "serfs", childDirs[0], "origin.md"))).toBe(true);
    expect(readFileSync(join(root, ".bandit", "serfs", "critic", "children", childDirs[0] + ".md"), "utf-8")).toContain("spawned_by: summon:critic");
    // the thread carries the researcher's voice
    const threadDirs = ["backlog", "in-progress", "review", "done"].map((c) => join(root, ".bandit", "board", c, "summon-card"));
    const found = threadDirs.find((d) => existsSync(join(d, "consult.md")));
    expect(found).toBeTruthy();
    const thread = readFileSync(join(found!, "consult.md"), "utf-8");
    expect(thread).toContain("**researcher:**");
    expect(thread).toContain("DECISION: amend");
  });

  test("SUMMON for an undefined role → consult.summon_failed, consult proceeds without the voice", async () => {
    seedCard("summon-missing", `${"- build module ".repeat(20)}\n\n${Array.from({ length: 5 }, (_, i) => `- criterion ${i}`).join("\n")}\n`);
    const transport = writeStub("stub-miss.sh", [
      "#!/bin/sh",
      'if echo "$1" | grep -q "Grade this output"; then echo "VERDICT: pass\\nCONFIDENCE: 0.9\\nREASONING: ok"; exit 0; fi',
      'case "$1" in',
      '  *"consult: plan"*) echo "Need a quant.\\n\\nSUMMON: quant\\n\\nDECISION: proceed";;',
      '  *) echo "work\\nVERIFICATION_COMMAND: true\\nVERIFICATION_EXIT_CODE: 0\\nVERIFICATION_OUTPUT: pass";;',
      "esac",
    ].join("\n"));
    await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 1 });
    const events = readFileSync(join(root, ".bandit", "events", new Date().toISOString().slice(0, 10) + ".jsonl"), "utf-8");
    expect(events).toContain("consult.summon_failed");
    expect(events).toContain('"reason":"no such serf prompt"');
    // no child spawned for a failed summon
    expect(readdirSync(join(root, ".bandit", "serfs")).filter((n) => n.startsWith("quant-consult-")).length).toBe(0);
  });

  test("stagnation consult SUMMON: wall-or-doorway answered by the domain voice", async () => {
    seedCard("summon-stag");
    const transport = writeStub("stub-stag.sh", [
      "#!/bin/sh",
      'if echo "$1" | grep -q "Grade this output"; then echo "VERDICT: fail\\nCONFIDENCE: 0.9\\nREASONING: no evidence cited"; exit 0; fi',
      'case "$1" in',
      '  *"re-weigh"*) echo "It is a doorway — the evidence step was missing.\\n\\nDECISION: amend";;',
      '  *"SUMMONED VOICE"*) echo "This is a capability gap: evidence-pipeline.";;',
      '  *"CONSULT (stagnation)"*) echo "Persistent wall — this needs the researcher.\\n\\nSUMMON: researcher\\n\\nDECISION: amend";;',
      '  *"CONSULT (routing)"*) echo "Retry.\\n\\nDECISION: proceed";;',
      '  *) echo "attempt\\nVERIFICATION_COMMAND: false\\nVERIFICATION_EXIT_CODE: 1\\nVERIFICATION_OUTPUT: FAIL: expected 3 got 2";;',
      "esac",
    ].join("\n"));
    await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 3 });
    const events = readFileSync(join(root, ".bandit", "events", new Date().toISOString().slice(0, 10) + ".jsonl"), "utf-8");
    expect(events).toContain('"thread":"stagnation"');
    expect(events).toContain("consult.summoned");
    // no spawn on a consult summons (only specialist routes spawn "specialists/")
    expect(readdirSync(join(root, ".bandit", "serfs")).filter((n) => n.startsWith("specialist-")).length).toBe(0);
  });

  test("parseSummon extracts the role", () => {
    expect(parseSummon("reasoning...\nSUMMON: researcher\nDECISION: amend")).toBe("researcher");
    expect(parseSummon("SUMMON: architect because the shape matters")).toBe("architect");
    expect(parseSummon("no summon here")).toBeNull();
  });
});
