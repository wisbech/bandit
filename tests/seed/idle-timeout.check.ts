// Seed check: idle-timeout. Human-owned; a candidate that edits this file is rejected by the judge.
// Run via: bash scripts/seed/idle-timeout.sh   (or: bun test ./tests/seed/idle-timeout.check.ts)
//
// The headless transport's liveness is one timeout reset by every stream event,
// with the idle limit injectable as TransportConfig.idleTimeoutMs (default 300_000).
// A worker that keeps talking is never killed for idling; one that goes silent is killed
// within the limit plus a small margin and reported stalled. The run timeout also reports stalled.
//
// Limits are generous (events 300 ms apart against a 1000-1500 ms limit) so a loaded machine
// does not flake the check; the base tree's 10 s interval still cannot meet the upper bounds.
// The last line before a worker exits can race the exit, so assertions name an earlier line.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTransport } from "../../src/runner";

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "seed-idle-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function stub(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

async function run(command: string, idleTimeoutMs: number | undefined, timeoutMs: number) {
  const cfg: any = { kind: "headless", command, args: [] };
  if (idleTimeoutMs !== undefined) cfg.idleTimeoutMs = idleTimeoutMs;
  const t0 = Date.now();
  const r = await runTransport(cfg, "prompt", dir, join(dir, "out.md"), timeoutMs);
  return { r, elapsed: Date.now() - t0 };
}

describe("seed idle-timeout: the idle watchdog is a resettable timeout", () => {
  test("a worker that emits an event every 300 ms for 2.4 s is not killed with a 1500 ms idle limit", async () => {
    const p = stub("chatty.sh", 'for i in 1 2 3 4 5 6 7 8; do echo "tick $i"; sleep 0.3; done\necho finished\nsleep 0.3');
    const { r } = await run(p, 1_500, 15_000);
    expect(r.stalled ?? false).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("tick 8");
  }, 30_000);

  test("a worker that goes silent is killed within the idle limit plus a small margin, and reported stalled", async () => {
    const p = stub("silent.sh", "echo started\nexec sleep 30");
    const { r, elapsed } = await run(p, 1_000, 8_000);
    expect(r.stalled).toBe(true);
    expect(r.ok).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(4_000);
  }, 30_000);

  test("each event resets the clock: 3 s of events 300 ms apart survive a 1000 ms limit, the silence after them does not", async () => {
    const p = stub("then-silent.sh", 'for i in 1 2 3 4 5 6 7 8 9 10; do echo "tick $i"; sleep 0.3; done\nexec sleep 30');
    const { r, elapsed } = await run(p, 1_000, 12_000);
    expect(r.output).toContain("tick 10");
    expect(r.stalled).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(2_900);
    expect(elapsed).toBeLessThan(6_500);
  }, 30_000);

  test("the run timeout still ends a worker that never stops talking, reported stalled", async () => {
    const p = stub("endless.sh", "while true; do echo tick; sleep 0.1; done");
    const { r, elapsed } = await run(p, 5_000, 1_500);
    expect(r.stalled).toBe(true);
    expect(elapsed).toBeLessThan(4_500);
  }, 30_000);

  test("without idleTimeoutMs the default limit is long: a 1.5 s silence is not a stall", async () => {
    const p = stub("pause.sh", "sleep 1.5\necho ok\nsleep 0.3");
    const { r } = await run(p, undefined, 15_000);
    expect(r.stalled ?? false).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("ok");
  }, 30_000);
});
