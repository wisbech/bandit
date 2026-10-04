// Seed check: no-heartbeat. Human-owned; a candidate that edits this file is rejected by the judge.
// Run via: bash scripts/seed/no-heartbeat.sh   (or: bun test ./tests/seed/no-heartbeat.check.ts)
//
// The persistent loop (runLoop with once: false) holds no interval timers of its own: it waits
// on fs.watch and wakes on board events. It must still hold (never resolve) and still wake
// when a card lands in backlog. Runs the loop in a child process that records every
// setInterval call, so the test process holds no watchers.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "seed-heartbeat-")));
  for (const c of ["backlog", "in-progress", "review", "done"]) mkdirSync(join(root, ".bandit", "board", c), { recursive: true });
  mkdirSync(join(root, ".bandit", "events"), { recursive: true });
  for (const name of ["master", "critic", "actor"]) {
    mkdirSync(join(root, ".bandit", "serfs", name), { recursive: true });
    writeFileSync(join(root, ".bandit", "serfs", name, "serf.md"), `# ${name}\n`);
    writeFileSync(join(root, ".bandit", "serfs", name, "prompt.md"), `You are ${name}.\nTASK: {{card.task}}\n`);
  }
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const PROBE = `
const [loopPath, root] = process.argv.slice(2);
const calls = [];
const orig = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => { calls.push(Number(ms)); return orig(fn, ms, ...rest); };
process.chdir(root);
const { runLoop } = await import(loopPath);
const { existsSync } = await import("node:fs");
const { join } = await import("node:path");
let resolved = false, error = null;
runLoop({ root, transport: { kind: "headless", command: "true", args: [] }, once: false, maxRetries: 1 })
  .then(() => { resolved = true; }, (e) => { error = String(e); });
await new Promise((r) => setTimeout(r, 1500));
const heldBeforeCard = !resolved && error === null;
const intervalsWhileHolding = [...calls];
const card = join(root, ".bandit", "board", "backlog", "wake-me");
const { mkdirSync, writeFileSync } = await import("node:fs");
mkdirSync(card, { recursive: true });
writeFileSync(join(card, "card.md"), "---\\nid: wake-me\\ntitle: wake me\\nverify: true\\n---\\n# wake me\\n- works\\n");
let woke = false;
for (let i = 0; i < 80 && !woke; i++) {
  await new Promise((r) => setTimeout(r, 100));
  woke = !existsSync(card);
}
console.log("PROBE " + JSON.stringify({ heldBeforeCard, intervalsWhileHolding, intervalsTotal: calls, resolved, error, woke }));
process.exit(0);
`;

describe("seed no-heartbeat: the persistent loop holds no timers of its own", () => {
  test("runLoop({ once: false }) creates no setInterval, still holds, and still wakes on a new card", async () => {
    const probe = join(root, "probe.mjs");
    writeFileSync(probe, PROBE);
    const loopPath = join(import.meta.dir, "..", "..", "src", "loop.ts");
    const p = Bun.spawn(["bun", "run", probe, loopPath, root], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => p.kill(), 25_000);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    clearTimeout(killer);
    const line = out.split("\n").find((l) => l.startsWith("PROBE "));
    if (!line) throw new Error(`probe printed no result.\nstdout:\n${out.slice(-2000)}\nstderr:\n${err.slice(-2000)}`);
    const r = JSON.parse(line.slice(6));
    expect(r.intervalsWhileHolding).toEqual([]);
    expect(r.error).toBeNull();
    expect(r.heldBeforeCard).toBe(true);
    expect(r.woke).toBe(true);
    expect(r.intervalsTotal).toEqual([]);
  }, 30_000);
});
