import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  getClaim, strengthen, weaken, decayAll, revive, readLedger,
  plasticity, globalPlasticity, rankLeversForPull, renderConfidence, readLedgerEvents,
} from "../src/confidence";
import { seedDefaultFolders } from "./v30-helpers";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bandit-conf-"));
  process.chdir(root);
  seedDefaultFolders(root);
});

afterEach(() => {
  process.chdir("/");
  rmSync(root, { recursive: true, force: true });
});

describe("Bucket-brigade update rules", () => {
  test("strengthen raises strength, never past 1, records pull + corroboration", () => {
    const c1 = strengthen(root, "lever:verdicts", 0.6, 2, "t1");
    expect(c1.strength).toBeGreaterThan(0);
    expect(c1.corroborations).toBe(1);
    const c2 = strengthen(root, "lever:verdicts", 0.6, 2, "t2");
    expect(c2.strength).toBeGreaterThan(c1.strength);
    expect(c2.strength).toBeLessThanOrEqual(1);
  });

  test("independent measures pay more than one", () => {
    const one = strengthen(root, "lever:one", 1, 1, "t");
    const two = strengthen(root, "lever:two", 1, 2, "t");
    expect(two.strength).toBeGreaterThan(one.strength);
  });

  test("weaken on flat pull; repeated flats kill the lever", () => {
    strengthen(root, "lever:dying", 0.8, 2, "seed");
    let c = weaken(root, "lever:d", "flat 1");
    expect(c.strength).toBeLessThan(0.5);
    c = weaken(root, "lever:d", "flat 2");
    c = weaken(root, "lever:d", "flat 2");
    c = weaken(root, "lever:d", "flat 3");
    expect(c.status).toBe("dead");
  });

  test("decay erodes without confirmation — silence is never agreement", () => {
    strengthen(root, "lever:decay-test", 1, 2, "t");
    const before = getClaim(root, "lever:decay-test").strength;
    decayAll(root);
    const after = getClaim(root, "lever:decay-test").strength;
    expect(after).toBeLessThan(before);
  });

  test("revive re-opens a dead lever at the floor (doctrine is falsifiable)", () => {
    for (let i = 0; i < 4; i++) weaken(root, "lever:d2", "flat");
    expect(getClaim(root, "lever:d2").status).toBe("dead");
    const revived = revive(root, "lever:d2", "fresh contradicting delta");
    expect(revived.status).toBe("tested");
    expect(revived.strength).toBeGreaterThan(0);
  });
});

describe("Status transitions", () => {
  test("provisional → tested → corroborated → established as corroboration accumulates", () => {
    let c = getClaim(root, "lever:ladder");
    expect(c.status).toBe("provisional");
    let cur = strengthen(root, "lever:ladder", 0.8, 2, "t1"); // tested
    expect(cur.status).toBe("tested");
    for (let i = 0; i < 4; i++) cur = strengthen(root, "lever:ladder", 0.9, 2, `t${i}`);
    expect(["corroborated", "established"]).toContain(cur.status);
  });

  test("established requires ≥2 corroborations (no single-coincidence doctrine)", () => {
    const c = strengthen(root, "lever:one-hit", 1, 2, "single lucky pull");
    expect(c.status).not.toBe("established");
  });
});

describe("Plasticity (derived, not configured)", () => {
  test("plasticity is inverse of strength", () => {
    const c = strengthen(root, "lever:p1", 1, 2, "t");
    expect(plasticity(c)).toBeLessThan(1 - 0.3);
    const fresh = getClaim(root, "lever:never-pulled");
    expect(plasticity(fresh)).toBe(1);
  });

  test("global plasticity falls as claims establish", () => {
    for (let i = 0; i < 6; i++) strengthen(root, "lever:est", 1, 2, "t");
    const after = globalPlasticity(root, { measureVolatility: 0.3, recentKillRate: 0.1 });
    expect(after).toBeLessThan(1);
  });

  test("empty ledger is maximally plastic", () => {
    expect(globalPlasticity(root, { measureVolatility: 0.5, recentKillRate: 0.2 })).toBe(1);
  });
});

describe("Master standing question", () => {
  test("ranking favors corroborated levers but keeps an exploration share", () => {
    // established lever
    for (let i = 0; i < 6; i++) strengthen(root, "lever:winner", 0.9, 2, "t");
    // weak lever (one pull)
    strengthen(root, "lever:newcomer", 0.3, 1, "t");
    const ranked = rankLeversForPull(root);
    expect(ranked[0].id).toBe("lever:winner");
    // newcomer still scored (exploration share > 0)
    const newcomer = ranked.find((c) => c.id === "lever:newcomer");
    expect(newcomer!.score).toBeGreaterThan(0);
  });
});

describe("Audit trail", () => {
  test("ledger events are recorded and readable", () => {
    strengthen(root, "lever:audit", 0.5, 1, "t");
    weaken(root, "lever:audit-w", "flat");
    decayAll(root);
    const events = readLedgerEvents(root);
    expect(events.some((e) => e.type === "corroborated")).toBe(true);
    expect(events.some((e) => e.type === "weakened")).toBe(true);
    expect(events.some((e) => e.type === "decay")).toBe(true);
  });
});