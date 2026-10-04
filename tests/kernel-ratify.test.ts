import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acceptRef, defaultExec, ratify, type GateRun } from "../src/kernel/judge";
import { readEvents } from "../src/kernel/log";
import { seedDefaultFolders } from "./v30-helpers";

// Checks the judged cannot edit: the verify argv, the check files and the
// project config come from the base (main), never from the candidate or the
// live card. A candidate that touches a check, checks/, the kernel or the
// project config fails with gate protected-paths.

let root: string;

function git(...args: string[]): string {
  const r = defaultExec(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], root);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

function commit(msg: string): void {
  git("add", "-A");
  git("commit", "-q", "-m", msg);
}

// A candidate branch cut from main with the given file edits.
function candidate(name: string, files: Record<string, string>): void {
  git("checkout", "-q", "-b", name, "main");
  for (const [p, t] of Object.entries(files)) write(p, t);
  commit(name);
  git("checkout", "-q", "main");
}

function seedCard(id: string, verify: string): void {
  const d = join(root, ".bandit", "board", "backlog", id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "card.md"), `---\nid: ${id}\nverify: ${verify}\n---\n# ${id}\n`);
}

const CHECK = "grep -q feature feature.txt\n"; // the ratified check: feature.txt must say feature
const gate = (r: { gates: GateRun[] }, name: string) => r.gates.find((g) => g.name === name);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bandit-ratify-")));
  process.chdir(root);
  seedDefaultFolders(root);
  git("init", "-q", "-b", "main");
  write(".gitignore", ".bandit/\n");
  write("t/check.sh", CHECK);
  commit("base");
  // The live card's verify says `true`: a ratified check must not use it.
  seedCard("c1", "true");
  ratify(root, root, "c1", ["t/check.sh"], "sh t/check.sh");
  commit("ratify c1");
});

afterEach(() => {
  process.chdir("/");
  rmSync(root, { recursive: true, force: true });
});

test("ratify writes checks/<id>.json with argv, paths and hashes, and logs card.ratified", () => {
  const r = JSON.parse(readFileSync(join(root, "checks", "c1.json"), "utf-8"));
  expect(r).toMatchObject({ card: "c1", verify: ["sh", "t/check.sh"], checkPaths: ["t/check.sh"] });
  expect(r.sha256["t/check.sh"]).toMatch(/^[0-9a-f]{64}$/);
  expect(readEvents(root).find((e) => e.type === "card.ratified")).toMatchObject({ card: "c1", checkPaths: ["t/check.sh"] });
  // The CLI verb does the same and does not commit.
  seedCard("c9", "sh t/check.sh");
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const p = Bun.spawnSync(["bun", cli, "ratify", "c9", "--paths", "t/check.sh"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(0);
  expect(p.stdout.toString()).toContain("commit this file on your base branch");
  expect(existsSync(join(root, "checks", "c9.json"))).toBe(true);
  expect(git("status", "--porcelain")).toContain("checks/");
  expect(Bun.spawnSync(["bun", cli, "ratify", "c9"], { cwd: root }).exitCode).toBe(2);
});

test("honest candidate passes, and the verify argv is the ratified one, not the live card's `true`", async () => {
  candidate("honest", { "feature.txt": "feature\n" });
  const r = await acceptRef({ root, cardId: "c1", ref: "honest" });
  expect(r.passed).toBe(true);
  expect(r.ratified).toBe(true);
  expect(gate(r, "verify")!.argv).toEqual(["sh", "t/check.sh"]);
  expect(r.gates.map((g) => g.name)).toEqual(["ratified-checks", "verify"]);
  expect(readEvents(root).find((e) => e.type === "acceptance.passed")).toMatchObject({ ratified: true, base: git("rev-parse", "main") });
});

test("the ratified argv decides: a candidate the live card's `true` would pass fails", async () => {
  candidate("nothing", { "other.txt": "x\n" });
  const r = await acceptRef({ root, cardId: "c1", ref: "nothing" });
  expect(r.passed).toBe(false);
  expect(gate(r, "verify")!.exitCode).not.toBe(0);
});

test("a candidate that weakens its own ratified test file fails: protected-paths names the file", async () => {
  candidate("weaken", { "t/check.sh": "exit 0\n" });
  const r = await acceptRef({ root, cardId: "c1", ref: "weaken" });
  expect(r.passed).toBe(false);
  expect(r.gates.map((g) => g.name)).toEqual(["protected-paths"]);
  expect(gate(r, "protected-paths")!.output).toBe("t/check.sh");
});

test("a candidate that edits checks/<id>.json fails", async () => {
  candidate("rerat", { "checks/c1.json": JSON.stringify({ card: "c1", verify: ["true"], checkPaths: [], sha256: {} }), "feature.txt": "feature\n" });
  const r = await acceptRef({ root, cardId: "c1", ref: "rerat" });
  expect(r.passed).toBe(false);
  expect(gate(r, "protected-paths")!.output).toContain("checks/c1.json");
});

test("a candidate that edits src/kernel/ fails", async () => {
  candidate("kern", { "src/kernel/x.ts": "export const x = 1;\n", "feature.txt": "feature\n" });
  const r = await acceptRef({ root, cardId: "c1", ref: "kern" });
  expect(r.passed).toBe(false);
  expect(gate(r, "protected-paths")!.output).toContain("src/kernel/x.ts");
});

test("a check file changed on main after ratification (hash mismatch at base) fails", async () => {
  write("t/check.sh", "true\n");
  commit("loosen the check without re-ratifying");
  candidate("honest2", { "feature.txt": "feature\n" });
  const r = await acceptRef({ root, cardId: "c1", ref: "honest2" });
  expect(r.passed).toBe(false);
  expect(gate(r, "ratified-checks")!.exitCode).toBe(1);
  expect(gate(r, "ratified-checks")!.output).toContain("t/check.sh");
  expect(gate(r, "verify")).toBeUndefined();
});

test("no ratification: passes with ratified:false; fails when bandit.json requires ratification", async () => {
  seedCard("c2", "test -f feature.txt");
  candidate("feat2", { "feature.txt": "feature\n" });
  const r = await acceptRef({ root, cardId: "c2", ref: "feat2" });
  expect(r.passed).toBe(true);
  expect(r.ratified).toBe(false);
  expect(readEvents(root).filter((e) => e.type === "acceptance.passed").pop()).toMatchObject({ card: "c2", ratified: false });
  write("bandit.json", JSON.stringify({ requireRatified: true }));
  commit("require ratified checks");
  const r2 = await acceptRef({ root, cardId: "c2", ref: "feat2" });
  expect(r2.passed).toBe(false);
  expect(r2.gates.map((g) => g.name)).toEqual(["ratification"]);
});

test("setup argv runs in the judge worktree before verify", async () => {
  write("bandit.json", JSON.stringify({ setup: [["sh", "-c", "echo built > built.txt"]] }));
  commit("setup");
  seedCard("c3", "test -f built.txt");
  candidate("feat3", { "feature.txt": "feature\n" });
  const r = await acceptRef({ root, cardId: "c3", ref: "feat3" });
  expect(r.passed).toBe(true);
  expect(r.gates.map((g) => g.name)).toEqual(["setup-1", "verify"]);
  expect(existsSync(join(root, "built.txt"))).toBe(false); // never the caller's tree
});

test("bandit.json is read from the base, not the candidate or the working tree", async () => {
  write("bandit.json", JSON.stringify({ gates: [["sh", "-c", "echo base-gate; exit 7"]] }));
  commit("a gate on main");
  // Candidate drops the gates: protected-paths names bandit.json.
  candidate("nogates", { "bandit.json": JSON.stringify({ gates: [] }), "feature.txt": "feature\n" });
  const r = await acceptRef({ root, cardId: "c1", ref: "nogates" });
  expect(r.passed).toBe(false);
  expect(gate(r, "protected-paths")!.output).toContain("bandit.json");
  // An honest candidate with an edited (uncommitted) bandit.json in the working tree: the base gate still runs.
  candidate("honest4", { "feature.txt": "feature\n" });
  write("bandit.json", JSON.stringify({ gates: [] }));
  const r2 = await acceptRef({ root, cardId: "c1", ref: "honest4" });
  expect(r2.passed).toBe(false);
  expect(gate(r2, "gate-1")).toMatchObject({ exitCode: 7 });
  expect(gate(r2, "gate-1")!.output).toContain("base-gate");
});
