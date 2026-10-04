import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runLoop } from "../src/loop";
import { claimCard, moveCard, latestClaim, self, cardsIn, processStart } from "../src/kernel/card";
import { appendEvent, readEvents } from "../src/kernel/log";
import { seedDefaultFolders } from "./v30-helpers";

// Claims, no locks: a claim is a rename with one winner; a move names its
// source column; only the latest claimant moves a card out of in-progress.

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bandit-claim-")));
  process.chdir(root);
  seedDefaultFolders(root);
});

afterEach(() => {
  process.chdir("/");
  rmSync(root, { recursive: true, force: true });
});

function seedCard(id: string, column = "backlog"): void {
  const d = join(root, ".bandit", "board", column, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "card.md"), `---\nid: ${id}\ntitle: ${id}\nverify: true\n---\n# ${id}\n- works\n`);
}

function writeStub(name: string, body: string): string {
  const p = join(root, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

// Green worker: self-verify passes; the grader reply has no VERDICT (plumbing) so the gate decides.
const GREEN = "#!/bin/sh\nsleep 0.05\ncat << 'OUT'\nDid the work.\nVERIFICATION_COMMAND: true\nVERIFICATION_EXIT_CODE: 0\nVERIFICATION_OUTPUT: ok\nOUT\n";

const col = (id: string) => ["backlog", "in-progress", "review", "done"].find((c) => existsSync(join(root, ".bandit", "board", c, id, "card.md")));

test("fenced move fails (returns false) when the card is not in the named column", () => {
  seedCard("f1", "review");
  expect(moveCard(root, "f1", "in-progress", "done")).toBe(false);
  expect(col("f1")).toBe("review");
  expect(moveCard(root, "f1", "review", "backlog")).toBe(true);
  expect(col("f1")).toBe("backlog");
});

test("claimCard: one winner, the loser gets false; card.claimed carries pid and process start time", () => {
  seedCard("c1");
  expect(claimCard(root, "c1")).toBe(true);
  expect(claimCard(root, "c1", { pid: 1, startedAt: "someone else" })).toBe(false);
  expect(col("c1")).toBe("in-progress");
  const claims = readEvents(root).filter((e) => e.type === "card.claimed");
  expect(claims.length).toBe(1);
  expect(claims[0]).toMatchObject({ card: "c1", pid: process.pid });
  expect(String(claims[0].startedAt)).not.toBe("unknown");
  expect(latestClaim(root, "c1")).toEqual(self());
  expect(cardsIn(root, "in-progress").map((c) => c.id)).toEqual(["c1"]); // no hidden in-flight folder left
});

test("a dead claimant's card is reclaimed, then claimed and worked by the live loop", async () => {
  seedCard("dead-1", "in-progress");
  seedCard("dead-2", "in-progress");
  // Same pid, different start time = the pid was reused: the old claimant is dead.
  const reused = { pid: process.pid, startedAt: "Thu Jan 1 00:00:00 1970" };
  appendEvent(root, "card.claimed", { card: "dead-1", ...reused });
  appendEvent(root, "card.claimed", { card: "dead-2", pid: 2 ** 22 + 7, startedAt: "Thu Jan 1 00:00:00 1970" });
  // A card claimed by a live process that is not us is left alone.
  seedCard("theirs", "in-progress");
  const live = { pid: 1, startedAt: processStart(1)! };
  appendEvent(root, "card.claimed", { card: "theirs", ...live });

  const r = await runLoop({ once: true, root, transport: { kind: "headless", command: writeStub("g.sh", GREEN), args: [] }, maxRetries: 1 });
  expect(r.completed).toBe(2);
  const ev = readEvents(root);
  const reclaimed = ev.filter((e) => e.type === "card.reclaimed");
  expect(reclaimed.map((e) => e.card).sort()).toEqual(["dead-1", "dead-2"]);
  expect(reclaimed.find((e) => e.card === "dead-1")?.from).toEqual(reused);
  expect(col("dead-1")).toBe("done");
  expect(col("dead-2")).toBe("done");
  expect(col("theirs")).toBe("in-progress");
  expect(ev.some((e) => e.type === "pipeline.selected" && e.card === "theirs")).toBe(false);
}, 30_000);

test("an in-progress card with no claim at all (pre-claim boards) is reclaimable", async () => {
  seedCard("legacy", "in-progress");
  const r = await runLoop({ once: true, root, transport: { kind: "headless", command: writeStub("g.sh", GREEN), args: [] }, maxRetries: 1 });
  expect(r.completed).toBe(1);
  expect(readEvents(root).find((e) => e.type === "card.reclaimed")).toMatchObject({ card: "legacy", from: null });
  expect(col("legacy")).toBe("done");
}, 30_000);

test("a zombie whose claim was superseded cannot move the card: card.claim_lost, card stays put", async () => {
  seedCard("z1");
  // While the worker runs, another claimant takes the card over (its claim lands later on the log).
  const forged = join(root, ".bandit", "events", "zz-other.jsonl");
  const stub = writeStub("z.sh", [
    "#!/bin/sh",
    `printf '{"type":"card.claimed","ts":"%s.999Z","card":"z1","pid":1,"startedAt":"other"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%S)" >> "${forged}"`,
    "cat << 'OUT'\nDid the work.\nVERIFICATION_COMMAND: true\nVERIFICATION_EXIT_CODE: 0\nVERIFICATION_OUTPUT: ok\nOUT",
  ].join("\n"));
  const r = await runLoop({ once: true, root, transport: { kind: "headless", command: stub, args: [] }, maxRetries: 1 });
  expect(r.completed).toBe(0);
  expect(col("z1")).toBe("in-progress");
  const ev = readEvents(root);
  expect(ev.find((e) => e.type === "card.claim_lost")).toMatchObject({ card: "z1", to: "done", claimant: { pid: 1, startedAt: "other" } });
  expect(ev.some((e) => e.type === "card.completed")).toBe(false);
}, 30_000);

test("two processes on one board of 12 cards: every card claimed exactly once, none processed twice", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `card-${String(i + 1).padStart(2, "0")}`);
  for (const id of ids) seedCard(id);
  const stub = writeStub("g.sh", GREEN);
  const script = join(root, "run-loop.ts");
  writeFileSync(script, [
    `import { runLoop } from ${JSON.stringify(resolve(import.meta.dir, "../src/loop.ts"))};`,
    `const r = await runLoop({ once: true, root: process.argv[2], transport: { kind: "headless", command: process.argv[3], args: [] }, maxRetries: 1 });`,
    `console.log("RESULT " + JSON.stringify(r));`,
  ].join("\n"));
  const procs = [0, 1].map(() => Bun.spawn(["bun", script, root, stub], { cwd: root, stdout: "pipe", stderr: "pipe" }));
  const outs = await Promise.all(procs.map(async (p) => { await p.exited; return await new Response(p.stdout).text(); }));
  const results = outs.map((o) => JSON.parse(o.match(/RESULT (.+)/)![1]));
  expect(results[0].processed + results[1].processed).toBe(12);

  const ev = readEvents(root);
  for (const id of ids) {
    const claims = ev.filter((e) => e.type === "card.claimed" && e.card === id);
    const worked = ev.filter((e) => e.type === "pipeline.selected" && e.card === id);
    expect({ id, claims: claims.length, worked: worked.length, col: col(id) }).toEqual({ id, claims: 1, worked: 1, col: "done" });
  }
  expect(ev.filter((e) => e.type === "card.claim_lost").length).toBe(0);
  expect(new Set(procs.map((p) => p.pid)).size).toBe(2);
  const byPid = procs.map((p) => ev.filter((e) => e.type === "card.claimed" && e.pid === p.pid).length);
  console.log(`  claims per process: ${byPid.join(" + ")} = ${byPid[0] + byPid[1]}`);
}, 60_000);
