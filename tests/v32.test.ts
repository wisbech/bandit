import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { classifySignatures, snapshotSerfs, rollbackTo, applyEdit, runRefinePass, readHistory, type RefinerEdit } from "../src/refiner";
import { runTransport, parseGate } from "../src/runner";
import { seedDefaultFolders, appendTestEvent } from "./v30-helpers";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bandit-v32-"));
  process.chdir(root);
  seedDefaultFolders(root);
});

afterEach(() => {
  process.chdir("/");
  rmSync(root, { recursive: true, force: true });
});

describe("V3-2: failure signatures", () => {
  test("critic plumbing x2 triggers", () => {
    appendTestEvent(root, "critic.repair", { card: "a", turn: 1 });
    appendTestEvent(root, "critic.repair", { card: "a", turn: 2 });
    const sigs = classifySignatures(readWindow());
    expect(sigs.some((s) => s.kind === "critic_plumbing" && s.count >= 2)).toBe(true);
  });

  test("quiet window yields none", () => {
    appendTestEvent(root, "task.completed", { card: "ok" });
    expect(classifySignatures(readWindow())).toEqual([]);
  });

  function readWindow() {
    // read events via the refiner's own reader (indirect through shouldTrigger's input shape)
    const events: { type: string; ts: string; [k: string]: unknown }[] = [];
    const dir = join(root, ".bandit", "events");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(dir, f), "utf-8").split("\n")) {
        if (line.trim()) events.push(JSON.parse(line));
      }
    }
    return events;
  }
});

describe("V3-2: evidence-gated edits", () => {
  test("skill create gate: weak evidence refused, strong applied", () => {
    const weak: RefinerEdit = { target: "skill", serf: "actor", op: "create", name: "fix-imports", content: "how", evidence: "looks good", reason: "t" };
    expect(applyEdit(root, weak).applied).toBe(false);
    const strong: RefinerEdit = { target: "skill", serf: "actor", op: "create", name: "fix-imports", content: "how", evidence: "3 successful runs of the same pattern", reason: "t" };
    expect(applyEdit(root, strong).applied).toBe(true);
    expect(existsSync(join(root, ".bandit", "knowledge", "skills", "fix-imports"))).toBe(true);
  });

  test("skill delete is a retirement, not an erase", () => {
    mkdirSync(join(root, ".bandit", "knowledge", "skills", "dead"), { recursive: true });
    const edit: RefinerEdit = { target: "skill", serf: "actor", op: "delete", name: "dead", evidence: "invoked 5x with 0 positive outcomes", reason: "t" };
    expect(applyEdit(root, edit).applied).toBe(true);
    expect(existsSync(join(root, ".bandit", "knowledge", "skills", ".refiner-retired"))).toBe(true);
  });

  test("memory lesson deduplicates", () => {
    const edit: RefinerEdit = { target: "memory", serf: "actor", op: "add", content: "always pin bun version", evidence: "drift observed twice", reason: "t" };
    expect(applyEdit(root, edit).applied).toBe(true);
    expect(applyEdit(root, edit).applied).toBe(false);
  });

  test("FULL-REPLACEMENT prompt edit dropping template tags is rejected", () => {
    writeFileSync(join(root, ".bandit", "serfs", "actor", "prompt.md"), "You are actor.\nTASK: {{card.task}}\nkeep {{card.acceptance}}\n## Report\noutput here");
    const edit: RefinerEdit = { target: "prompt", serf: "actor", op: "update", content: "You are actor rewritten fully.\nNo template tags at all.\nEverything replaced with a complete new prompt body that is long enough to count as a full rewrite.", evidence: "signature x3", reason: "t" };
    const r = applyEdit(root, edit);
    expect(r.applied).toBe(false);
    expect(r.note).toContain("template tags");
    expect(readFileSync(join(root, ".bandit", "serfs", "actor", "prompt.md"), "utf-8")).toContain("{{card.task}}");
  });

  test("refiner note appends to prompt instead of clobbering it", () => {
    writeFileSync(join(root, ".bandit", "serfs", "actor", "prompt.md"), "You are actor.\nTASK: {{card.task}}\n");
    const edit: RefinerEdit = { target: "prompt", serf: "actor", op: "update", content: "Tied to signature verification_red: always name the failing artifact.", evidence: "verification_red x2", reason: "t" };
    const r = applyEdit(root, edit);
    expect(r.applied).toBe(true);
    const after = readFileSync(join(root, ".bandit", "serfs", "actor", "prompt.md"), "utf-8");
    expect(after).toContain("{{card.task}}");           // template survives
    expect(after).toContain("name the failing artifact"); // note merged in
  });
});

describe("V3-2: snapshots + rollback", () => {
  test("rollback restores byte-identical serf folders", () => {
    const before = readFileSync(join(root, ".bandit", "serfs", "actor", "prompt.md"), "utf-8");
    const ts = snapshotSerfs(root, ["actor"]);
    writeFileSync(join(root, ".bandit", "serfs", "actor", "prompt.md"), "# mutated");
    expect(rollbackTo(root, ts)).toBe(true);
    expect(readFileSync(join(root, ".bandit", "serfs", "actor", "prompt.md"), "utf-8")).toBe(before);
  });
});

describe("V3-2: refiner pass", () => {
  test("force pass with a stub refiner applies evidence-backed edits", async () => {
    appendTestEvent(root, "critic.repair", { card: "a", turn: 1 });
    appendTestEvent(root, "critic.repair", { card: "a", turn: 2 });
    const result = await runRefinePass(root, async () =>
      JSON.stringify([{ target: "memory", serf: "critic", op: "add", content: "critic plumbing recurs — check transport", evidence: "critic.repair x2 in events", reason: "recurring plumbing" }]),
    { force: true });
    expect(result.ran).toBe(true);
    expect(result.applied.length).toBe(1);
    expect(readFileSync(join(root, ".bandit", "serfs", "critic", "memory", "lessons.md"), "utf-8")).toContain("critic plumbing recurs");
    expect(readHistory(root).length).toBe(1);
  });

  test("non-forced pass without triggers does not run", async () => {
    const result = await runRefinePass(root, async () => "[]");
    expect(result.ran).toBe(false);
  });
});

describe("V3-2: UHP transport", () => {
  test("runTransport posts to /v1/responses and extracts text", async () => {
    // local stub server
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (req.url.endsWith("/v1/responses")) {
          const body = (await req.json()) as { input: string };
          return Response.json({
            status: "completed",
            error: null,
            output: [{ type: "message", content: [{ type: "output_text", text: `echo: ${body.input.slice(0, 20)}` }] }],
            usage: { total_tokens: 42 },
          }, { headers: { "UHP-Version": "2026-08-11" } });
        }
        return new Response("nf", { status: 404 });
      },
    });
    const result = await runTransport(
      { kind: "uhp", command: `http://127.0.0.1:${server.port}`, args: ["test-model"] },
      "hello uhp", root, join(root, "out.md"), 5000,
    );
    server.stop(true);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("echo: hello uhp");
    expect(result.tokensUsed).toBe(42);
  });
});