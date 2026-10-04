import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseScore, readScore } from "../src/kernel/score";
import { readEvents } from "../src/kernel/log";
import { seedDefaultFolders } from "./v30-helpers";

// The score: the project's own outside measure, read and logged, never a gate.

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bandit-score-")));
  process.chdir(root);
  seedDefaultFolders(root);
});

afterEach(() => {
  process.chdir("/");
  rmSync(root, { recursive: true, force: true });
});

const score = (argv: string[]) => writeFileSync(join(root, "bandit.json"), JSON.stringify({ score: argv }));

test("parseScore: a JSON number, an object with a numeric score, the last line after noise; garbage is null", () => {
  expect(parseScore("42\n")).toBe(42);
  expect(parseScore("0.125")).toBe(0.125);
  expect(parseScore('{"score": 3.5, "n": 12}')).toBe(3.5);
  expect(parseScore("building...\nran 12 cards\n7")).toBe(7);
  expect(parseScore("garbage")).toBeNull();
  expect(parseScore('{"score": "high"}')).toBeNull();
  expect(parseScore("")).toBeNull();
  expect(parseScore("NaN")).toBeNull();
});

test("readScore runs bandit.json's score argv and logs score.read {value, argv, sha}", () => {
  score(["sh", "-c", 'echo noise; echo \'{"score": 0.75}\'']);
  expect(readScore(root, root)).toBe(0.75);
  const e = readEvents(root).find((x) => x.type === "score.read");
  expect(e).toMatchObject({ value: 0.75, argv: ["sh", "-c", 'echo noise; echo \'{"score": 0.75}\''] });
  expect(e).toHaveProperty("sha"); // null here: not a git repo
});

test("readScore: garbage output is logged with value null; no score configured runs and logs nothing", () => {
  score(["sh", "-c", "echo not-a-number"]);
  expect(readScore(root, root)).toBeNull();
  expect(readEvents(root).find((x) => x.type === "score.read")).toMatchObject({ value: null });
  rmSync(join(root, "bandit.json"));
  const before = readEvents(root).length;
  expect(readScore(root, root)).toBeNull();
  expect(readEvents(root).length).toBe(before);
});

test("bandit score: exit 0 with the number; 2 when missing or unparsable", () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const run = () => Bun.spawnSync(["bun", cli, "score"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(run().exitCode).toBe(2); // no bandit.json
  score(["echo", "12"]);
  const ok = run();
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString().trim()).toBe("12");
  score(["echo", "twelve"]);
  expect(run().exitCode).toBe(2);
});
