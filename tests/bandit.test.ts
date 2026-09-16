import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { banditReady, getPosterior, updateOnPayoff, updateOnFlat, thompsonRank, probabilityBest, banditStatus, renderBandit } from "../src/bandit";
import { strengthen, weaken } from "../src/confidence";
import { seedDefaultFolders } from "./v30-helpers";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bandit-bandit-"));
  process.chdir(root);
  seedDefaultFolders(root);
});

afterEach(() => {
  process.chdir("/");
  rmSync(root, { recursive: true, force: true });
});

function trustInstrument(id: string): void {
  // promote a measure to corroborated (2+ corroborations, decent strength)
  strengthen(root, id, 0.8, 2, "instrument reads consistently");
  strengthen(root, id, 0.8, 2, "again");
}

function qualifyLever(id: string, payoffs: number): void {
  for (let i = 0; i < 3; i++) strengthen(root, id, 0.7, 2, `pull ${i}`);
  for (let i = 0; i < payoffs; i++) updateOnPayoff(root, id, 0.7, 2);
}

describe("Swap trigger: instrument convergence preconditions", () => {
  test("not ready with no trusted measures and few pulls", () => {
    const r = banditReady(root);
    expect(r.ready).toBe(false);
    expect(r.reasons.length).toBe(2);
  });

  test("ready once a measure is corroborated and 2 levers have pulls", () => {
    strengthen(root, "measure:revenue", 0.9, 2, "stable source");
    strengthen(root, "measure:revenue", 0.9, 2, "stable again");
    strengthen(root, "lever:a", 0.7, 2, "t");
    strengthen(root, "lever:a", 0.7, 2, "t");
    strengthen(root, "lever:a", 0.7, 2, "t");
    strengthen(root, "lever:b", 0.7, 2, "t");
    strengthen(root, "lever:b", 0.7, 2, "t");
    strengthen(root, "lever:b", 0.7, 2, "t");
    const r = banditReady(root);
    expect(r.ready).toBe(true);
    expect(r.trustedMeasures).toBe(1);
    expect(r.qualifiedLevers).toBe(2);
  });
});

describe("Posterior updates", () => {
  test("payoff raises mean; flat lowers it", () => {
    const up = updateOnPayoff(root, "lever:up", 0.8, 2);
    const down = updateOnFlat(root, "lever:down");
    // pessimistic prior: one payoff moves mean up but not past 0.5 yet
    expect(up.mean).toBeGreaterThan(getPosterior(root, "lever:untouched").mean);
    expect(down.mean).toBeLessThan(up.mean);
  });

  test("posterior mean is a probability (0..1)", () => {
    for (let i = 0; i < 5; i++) updateOnPayoff(root, "lever:good", 0.9, 2);
    const p = getPosterior(root, "lever:good");
    expect(p.mean).toBeGreaterThan(0);
    expect(p.mean).toBeLessThan(1);
    expect(p.alpha).toBeGreaterThan(p.beta);
  });
});

describe("Thompson sampling ranking", () => {
  test("clear winner is ranked first almost always", () => {
    for (let i = 0; i < 12; i++) updateOnPayoff(root, "lever:clear-winner", 0.9, 2);
    for (let i = 0; i < 12; i++) updateOnFlat(root, "lever:loser");
    let winnerFirst = 0;
    for (let trial = 0; trial < 20; trial++) {
      const ranked = thompsonRank(root);
      if (ranked[0].id === "lever:clear-winner") winnerFirst += 1;
    }
    expect(winnerFirst).toBeGreaterThanOrEqual(19); // decisive separation
  });

  test("close posteriors share the top spot (real exploration)", () => {
    for (let i = 0; i < 4; i++) updateOnPayoff(root, "lever:twin-a", 0.6, 1);
    for (let i = 0; i < 4; i++) updateOnPayoff(root, "lever:twin-b", 0.6, 1);
    const seen = new Set<string>();
    for (let trial = 0; trial < 30; trial++) seen.add(thompsonRank(root)[0].id);
    expect(seen.size).toBeGreaterThan(1); // both get pulled
  });
});

describe("Established = probability, not a vibe", () => {
  test("dominant lever has P(best) > 0.95", () => {
    for (let i = 0; i < 15; i++) updateOnPayoff(root, "lever:dominant", 0.9, 2);
    for (let i = 0; i < 15; i++) updateOnFlat(root, "lever:lame");
    const s = banditStatus(root, "lever:dominant");
    expect(s.pBest).toBeGreaterThan(0.95);
    expect(s.status).toBe("established");
  });

  test("uncertain lever stays below threshold", () => {
    for (let i = 0; i < 2; i++) updateOnPayoff(root, "lever:thin", 0.5, 1);
    const s = banditStatus(root, "lever:thin");
    expect(s.pBest).toBeLessThan(0.95);
    expect(s.status).not.toBe("established");
  });
});

describe("View", () => {
  test("renderBandit shows readiness and posteriors", () => {
    updateOnPayoff(root, "lever:visible", 0.7, 1);
    const view = renderBandit(root);
    expect(view).toContain("BANDIT GOVERNOR");
    expect(view).toContain("readiness:");
    expect(view).toContain("lever:visible");
  });
});