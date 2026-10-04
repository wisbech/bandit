// Seed check: drop-repair-board. Human-owned; a candidate that edits this file is rejected by the judge.
// Run via: bash scripts/seed/drop-repair-board.sh   (or: bun test ./tests/seed/drop-repair-board.check.ts)
//
// repairBoardFromEvents had no production caller; the directory is the only truth for a
// card's column, so a replay that renames folders from the log contradicts the kernel.
// It is gone; the loop module still loads and keeps its public surface.
import { test, expect, describe } from "bun:test";
import { join } from "node:path";

const loopPath = join(import.meta.dir, "..", "..", "src", "loop.ts");

describe("seed drop-repair-board", () => {
  test("src/loop.ts no longer exports repairBoardFromEvents", async () => {
    const loop: any = await import(loopPath);
    expect("repairBoardFromEvents" in loop).toBe(false);
    expect(loop.repairBoardFromEvents).toBeUndefined();
  });

  test("the loop module still loads with its public surface", async () => {
    const loop: any = await import(loopPath);
    for (const name of ["runLoop", "emit", "readEvents", "cardsIn", "reopenCard", "exitInProgress", "parseCriticVerdict"]) {
      expect(typeof loop[name]).toBe("function");
    }
  });
});
