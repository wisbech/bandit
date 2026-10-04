// Seed check: refiner-proposals. Human-owned; a candidate that edits this file is rejected by the judge.
// Run: bun test ./tests/seed/refiner-proposals.check.ts
//
// With "refiner": "propose" in .bandit/config.json, runRefinePass applies NO edit to serf folders.
// Each edit it would have applied (known serf, evidence of 4+ chars) becomes a proposal card folder
// .bandit/board/backlog/proposal-<...>/card.md carrying serf, target, op, content and evidence,
// and one refiner.proposed event per proposal. RefineResult.proposed lists the proposal card ids.
// Without the setting, edits are applied exactly as before.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runRefinePass } from "../../src/refiner";
import { appendEvent, readEvents } from "../../src/kernel/log";
import { parseCard } from "../../src/kernel/card";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "seed-refprop-")));
  for (const c of ["backlog", "in-progress", "review", "done"]) mkdirSync(join(root, ".bandit", "board", c), { recursive: true });
  for (const name of ["master", "critic", "actor"]) {
    mkdirSync(join(root, ".bandit", "serfs", name, "memory"), { recursive: true });
    writeFileSync(join(root, ".bandit", "serfs", name, "serf.md"), `# ${name}\n`);
    writeFileSync(join(root, ".bandit", "serfs", name, "prompt.md"), `You are ${name}.\nTASK: {{card.task}}\n`);
  }
  appendEvent(root, "critic.repair", { card: "a", turn: 0 });
  appendEvent(root, "critic.repair", { card: "a", turn: 1 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const EDITS = [
  { target: "memory", serf: "critic", op: "add", content: "LESSON-CRITIC-PLUMBING check the transport first", evidence: "EVIDENCE-ONE critic.repair x2 in events", reason: "recurring plumbing" },
  { target: "prompt", serf: "actor", op: "update", content: "NOTE-ACTOR name the failing artifact in every report", evidence: "EVIDENCE-TWO verification_red x2", reason: "red gates" },
  { target: "memory", serf: "nobody", op: "add", content: "ignored", evidence: "EVIDENCE-THREE unknown serf", reason: "skipped: unknown serf" },
  { target: "memory", serf: "critic", op: "add", content: "ignored too", evidence: "x", reason: "skipped: insufficient evidence" },
];
const refineFn = async () => JSON.stringify(EDITS);

function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(relative(dir, p) + "\0").update(readFileSync(p)).update("\0");
    }
  };
  walk(dir);
  return h.digest("hex");
}

const proposals = () => readdirSync(join(root, ".bandit", "board", "backlog")).filter((n) => n.startsWith("proposal-")).sort();

describe("seed refiner-proposals: the refiner writes proposal cards and applies nothing", () => {
  test('"refiner": "propose": serf folders are byte-identical, one proposal card per valid edit', async () => {
    writeFileSync(join(root, ".bandit", "config.json"), JSON.stringify({ refiner: "propose" }));
    const before = treeHash(join(root, ".bandit", "serfs"));
    const result: any = await runRefinePass(root, refineFn, { force: true });
    expect(treeHash(join(root, ".bandit", "serfs"))).toBe(before);
    expect(result.ran).toBe(true);
    expect(result.applied).toEqual([]);
    const ids = proposals();
    expect(ids.length).toBe(2);
    expect([...(result.proposed ?? [])].sort()).toEqual(ids);

    const cards = ids.map((id) => {
      const dir = join(root, ".bandit", "board", "backlog", id);
      return { id, card: parseCard(dir), raw: readFileSync(join(dir, "card.md"), "utf-8") };
    });
    const mem = cards.find((c) => c.card.frontmatter.serf === "critic");
    const pr = cards.find((c) => c.card.frontmatter.serf === "actor");
    expect(mem).toBeDefined();
    expect(pr).toBeDefined();
    for (const c of [mem!, pr!]) {
      expect(c.card.frontmatter.id).toBe(c.id);
      expect(c.card.frontmatter.title ?? "").not.toBe("");
    }
    expect(mem!.card.frontmatter.target).toBe("memory");
    expect(mem!.card.frontmatter.op).toBe("add");
    expect(mem!.card.body).toContain("LESSON-CRITIC-PLUMBING check the transport first");
    expect(mem!.card.body).toContain("EVIDENCE-ONE critic.repair x2 in events");
    expect(pr!.card.frontmatter.target).toBe("prompt");
    expect(pr!.card.frontmatter.op).toBe("update");
    expect(pr!.card.body).toContain("NOTE-ACTOR name the failing artifact in every report");
    expect(pr!.card.body).toContain("EVIDENCE-TWO verification_red x2");
    expect(cards.map((c) => c.raw).join("\n")).not.toContain("EVIDENCE-THREE");

    expect(existsSync(join(root, ".bandit", "serfs", "critic", "memory", "lessons.md"))).toBe(false);
    const proposed = readEvents(root).filter((e) => e.type === "refiner.proposed");
    expect(proposed.length).toBe(2);
    expect(proposed.map((e) => String(e.card)).sort()).toEqual(ids);
  });

  test("default (no refiner setting): edits are applied as before and no proposal cards appear", async () => {
    const result: any = await runRefinePass(root, refineFn, { force: true });
    expect(result.applied.length).toBe(2);
    expect(readFileSync(join(root, ".bandit", "serfs", "critic", "memory", "lessons.md"), "utf-8")).toContain("LESSON-CRITIC-PLUMBING");
    expect(readFileSync(join(root, ".bandit", "serfs", "actor", "prompt.md"), "utf-8")).toContain("NOTE-ACTOR");
    expect(proposals()).toEqual([]);
    expect(readEvents(root).some((e) => e.type === "refiner.proposed")).toBe(false);
  });

  test("two passes in propose mode never collide on a card id", async () => {
    writeFileSync(join(root, ".bandit", "config.json"), JSON.stringify({ refiner: "propose" }));
    await runRefinePass(root, refineFn, { force: true });
    await runRefinePass(root, refineFn, { force: true });
    expect(proposals().length).toBe(4);
  });
});
