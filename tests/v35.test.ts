import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { runLoop, emit } from "../src/loop";
import { renderCardDossier } from "../src/dossier";
import { parseGate, selfVerifyGateAsync } from "../src/runner";
import { seedDefaultFolders, appendTestEvent } from "./v30-helpers";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// V3-5: the card dossier — `bandit card <id>`.
// Pure projection over existing state: events jsonl + card folder + grading +
// consult.md. Every section cites its source file; nothing here writes.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bandit-v35-"));
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
  writeFileSync(join(cardDir, "card.md"), `---\ncolumn: backlog\nid: ${id}\ntitle: ${id}\n${extraFrontmatter}---\n# ${id}\n${body}`);
  return cardDir;
}

function writeStub(name: string, body: string): string {
  const p = join(root, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

const GREEN_STUB = `#!/bin/sh
cat << 'OUT'
Did the work.
VERIFICATION_COMMAND: true
VERIFICATION_EXIT_CODE: 0
VERIFICATION_OUTPUT: 3 pass
OUT
`;

describe("V3-5: card dossier", () => {
  test("renders timeline from events for the card", async () => {
    // runLoop drains the board; it never creates cards. Seed the card AND
    // its card.created event (the `task` command emits it, cli.ts:158) or
    // the timeline lacks the card's origin.
    seedCard("card-tl", undefined, "verify: true\n");
    emit("card.created", { card: "card-tl", title: "card-tl" });
    const transport = writeStub("stub-tl.sh", GREEN_STUB);
    await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 1 });
    const dossier = renderCardDossier(root, "card-tl");
    expect(dossier).toContain("TIMELINE");
    expect(dossier).toContain("card.created");
    expect(dossier).toContain("card.moved  to=in-progress");
    expect(dossier).toContain("pipeline.selected  pipeline=trivial");
    expect(dossier).toContain("round.started  round=1");
    expect(dossier).toContain("verification.green");
    expect(dossier).toContain("converged");
    expect(dossier).toContain("card.completed");
  });

  test("timeline excludes other cards' events", async () => {
    seedCard("mine");
    seedCard("other");
    emit("card.moved", { card: "mine", to: "in-progress" });
    emit("card.moved", { card: "other", to: "in-progress" });
    const dossier = renderCardDossier(root, "mine");
    expect(dossier).toContain('card.moved  to=in-progress');
    // exactly one card.moved line — the other card's event stays out
    expect((dossier.match(/card\.moved/g) ?? []).length).toBe(1);
  });

  test("consult.md rendered as a chat transcript when present", async () => {
    // Seed the card where the latest card.moved says it lives (in-progress)
    // — seeding in backlog too would recreate the duplicate-folder trap the
    // dossier's column scan exists to avoid.
    appendTestEvent(root, "card.moved", { card: "chat-card", to: "in-progress" });
    mkdirSync(join(root, ".bandit", "board", "in-progress", "chat-card"), { recursive: true });
    writeFileSync(
      join(root, ".bandit", "board", "in-progress", "chat-card", "card.md"),
      "---\ncolumn: in-progress\nid: chat-card\ntitle: chat-card\n---\n# chat-card\n",
    );
    writeFileSync(
      join(root, ".bandit", "board", "in-progress", "chat-card", "consult.md"),
      "# Consult thread\n\n**master:**\n\nSTAGNATION: gate fingerprint repeated. Same wall or different wall? End with DECISION line.\n\n**critic:**\n\nThe wall is the missing evidence step, not a capability gap.\n\nDECISION: amend\n\n",
    );
    const dossier = renderCardDossier(root, "chat-card");
    expect(dossier).toContain("CONSULT (card/consult.md)");
    expect(dossier).toContain("master");
    expect(dossier).toContain("STAGNATION: gate fingerprint repeated");
    expect(dossier).toContain("critic");
    expect(dossier).toContain("DECISION: amend");
  });

  test("no consult thread → stated absence, not silence", async () => {
    seedCard("lonely");
    const dossier = renderCardDossier(root, "lonely");
    expect(dossier).toContain("no consult thread");
  });

  test("grader verdicts shown per round from .bandit/grading/", async () => {
    seedCard("graded");
    appendTestEvent(root, "critic.verdict", { card: "graded", round: 1, verdict: "fail", confidence: 0.9, plumbing: false });
    appendTestEvent(root, "critic.verdict", { card: "graded", round: 2, verdict: "pass", confidence: 0.82, plumbing: false });
    const gradingDir = join(root, ".bandit", "grading");
    mkdirSync(gradingDir, { recursive: true });
    writeFileSync(join(gradingDir, "graded.md"), "VERDICT: pass\nCONFIDENCE: 0.82\nREASONING: converged with evidence\n");
    writeFileSync(join(gradingDir, "graded.seat-abc123.md"), "VERDICT: uncertain\nCONFIDENCE: 0\nREASONING: unparseable critic response\n");
    const dossier = renderCardDossier(root, "graded");
    expect(dossier).toContain("GRADER");
    expect(dossier).toContain("round 1: fail (0.90)");
    expect(dossier).toContain("round 2: pass (0.82)");
    expect(dossier).toContain(".bandit/grading/graded.md");
    expect(dossier).toContain("graded.seat-abc123.md");
  });

  test("ungraded card states the absence", () => {
    seedCard("raw");
    const dossier = renderCardDossier(root, "raw");
    expect(dossier).toContain("no grader verdicts");
  });

  test("artifacts listed with sizes", async () => {
    seedCard("card-ar", undefined, "verify: true\n");
    emit("card.created", { card: "card-ar", title: "card-ar" });
    const transport = writeStub("stub-ar.sh", GREEN_STUB);
    await runLoop({ once: true, root, transport: { kind: "headless", command: transport, args: [] }, maxRetries: 1 });
    const dossier = renderCardDossier(root, "card-ar");
    expect(dossier).toContain("ARTIFACTS");
    // paths are root-relative with the size before them (source-cited)
    expect(dossier).toMatch(/\.bandit\/board\/done\/card-ar\/card\.md\s+—/);
    expect(dossier).toMatch(/\d+ B\s+\.bandit\/board\/done\/card-ar\/card\.md/);
    expect(dossier).toMatch(/outputs\/run-\w+\.md/);
  });

  test("harness scratch (.bandit/tmp) folded to one counted line, real artifacts visible", () => {
    seedCard("card-scratch");
    const dir = join(root, ".bandit", "board", "backlog", "card-scratch", ".bandit", "tmp", "bunx-501-typescript@latest");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "lib.d.ts"), "x".repeat(10_000));
    writeFileSync(join(root, ".bandit", "board", "backlog", "card-scratch", "card.md"), "---\ncolumn: backlog\nid: card-scratch\ntitle: card-scratch\n---\n# card-scratch\n");
    const dossier = renderCardDossier(root, "card-scratch");
    // the scratch is folded — 600 bunx files would bury the card otherwise
    expect(dossier).toContain("harness scratch (TMPDIR redirect)");
    expect(dossier).not.toContain("lib.d.ts");
    // counted, not hidden: bytes + file count on the fold line
    expect(dossier).toMatch(/10,?000 B  .*\.bandit\/tmp\/  — harness scratch \(TMPDIR redirect\) — 1 file\(s\), folded/);
    // the real card artifact still lists individually
    expect(dossier).toMatch(/card\.md\s+— the card itself/);
  });

  test("every section cites its source file", async () => {
    seedCard("cites");
    appendTestEvent(root, "card.moved", { card: "cites", to: "in-progress" });
    const dossier = renderCardDossier(root, "cites");
    expect(dossier).toContain("TIMELINE (.bandit/events/");
    expect(dossier).toContain("CONSULT (card/consult.md)");
    expect(dossier).toContain("GRADER (.bandit/grading/");
    expect(dossier).toContain("ARTIFACTS (card folder)");
    expect(dossier).toContain("TASK (card.md)");
  });

  test("unknown card id → events-only dossier, not a crash", () => {
    // Library behavior: the RENDERER degrades to events-only. The CLI guard
    // (cli.ts) hard-fails first — this asserts the renderer's own contract.
    const dossier = renderCardDossier(root, "no-such-card");
    expect(dossier).toContain("no card folder found for this id");
    expect(dossier).toContain("(no events for this card)");
  });
});

// V3-5 regression: the self-verify seat must re-run the actor's reported
// command from the PROJECT ROOT, not the card folder — acceptance commands
// are written against the repo (bun test, pytest, …). The false red that
// burned muky62ac for three rounds (reported=0, actual=1, "0 test files
// matching") was cwd, not work.

describe("self-verify cwd: re-run from project root", () => {
  test("repo-relative command resolves from root, not the card folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "bandit-selfverify-"));
    try {
      mkdirSync(join(root, ".bandit"), { recursive: true });
      writeFileSync(join(root, ".bandit", "config.json"), "{}");
      const cardDir = join(root, ".bandit", "board", "in-progress", "card-root-cwd");
      mkdirSync(cardDir, { recursive: true });
      writeFileSync(join(cardDir, "card.md"), "---\ncolumn: in-progress\nverify: cat marker.txt\n---\n# t\n");
      writeFileSync(join(root, "marker.txt"), "project root marker\n");
      const gate = parseGate("VERIFICATION_COMMAND: cat marker.txt\nVERIFICATION_EXIT_CODE: 0");
      const sv = await selfVerifyGateAsync(gate, cardDir, 30_000, undefined, root);
      expect(sv.attempted).toBe(true);
      expect(sv.actualExitCode).toBe(0);
    } finally {
      process.chdir("/");
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to the card folder when no project root is present", async () => {
    const base = mkdtempSync(join(tmpdir(), "bandit-selfverify-"));
    try {
      const cardDir = join(base, "some", "other", "layout", "card-no-root");
      mkdirSync(cardDir, { recursive: true });
      writeFileSync(join(cardDir, "card.md"), "---\ncolumn: in-progress\nverify: cat marker.txt\n---\n# t\n");
      writeFileSync(join(cardDir, "marker.txt"), "card folder marker\n");
      const gate = parseGate("VERIFICATION_COMMAND: cat marker.txt\nVERIFICATION_EXIT_CODE: 0");
      const sv = await selfVerifyGateAsync(gate, cardDir, 30_000);
      expect(sv.attempted).toBe(true);
      expect(sv.actualExitCode).toBe(0);
    } finally {
      process.chdir("/");
      rmSync(base, { recursive: true, force: true });
    }
  });
});