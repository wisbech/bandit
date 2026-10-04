// Seed check: prompts-tracked. Human-owned; a candidate that edits this file is rejected by the judge.
// Run: bun test ./tests/seed/prompts-tracked.check.ts
//
// A serf's prompt has a tracked home: <root>/prompts/<serf>/prompt.md wins over
// <root>/.bandit/serfs/<serf>/prompt.md when it exists. readSerfFolder(dir, root?) takes the
// project root; runSerfOnCard passes opts.root. `bandit prompts export [--force]` copies every
// .bandit/serfs/<serf>/prompt.md to prompts/<serf>/prompt.md, never overwriting an existing
// tracked prompt unless --force.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SRC = join(import.meta.dir, "..", "..", "src");
const CLI = join(SRC, "cli.ts");

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "seed-prompts-")));
  for (const c of ["backlog", "in-progress", "review", "done"]) mkdirSync(join(root, ".bandit", "board", c), { recursive: true });
  mkdirSync(join(root, ".bandit", "events"), { recursive: true });
  for (const name of ["master", "critic", "actor"]) {
    mkdirSync(join(root, ".bandit", "serfs", name), { recursive: true });
    writeFileSync(join(root, ".bandit", "serfs", name, "serf.md"), `# ${name}\n`);
    writeFileSync(join(root, ".bandit", "serfs", name, "prompt.md"), `FROM-BANDIT ${name}: {{card.task}}\n`);
  }
  // a serf folder with no prompt.md: export skips it
  mkdirSync(join(root, ".bandit", "serfs", "mute"), { recursive: true });
  writeFileSync(join(root, ".bandit", "serfs", "mute", "serf.md"), "# mute\n");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function tracked(serf: string, text: string): void {
  mkdirSync(join(root, "prompts", serf), { recursive: true });
  writeFileSync(join(root, "prompts", serf, "prompt.md"), text);
}

function cli(...args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", CLI, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
}

describe("seed prompts-tracked: readSerfFolder prefers prompts/<serf>/prompt.md", () => {
  test("readSerfFolder(dir, root): the tracked prompt wins; without one the .bandit prompt is used", async () => {
    const runner: any = await import(join(SRC, "runner.ts"));
    tracked("actor", "FROM-TRACKED actor: {{card.task}}\n");
    const actor = runner.readSerfFolder(join(root, ".bandit", "serfs", "actor"), root);
    expect(actor.prompt).toBe("FROM-TRACKED actor: {{card.task}}\n");
    expect(actor.name).toBe("actor");
    const critic = runner.readSerfFolder(join(root, ".bandit", "serfs", "critic"), root);
    expect(critic.prompt).toBe("FROM-BANDIT critic: {{card.task}}\n");
  });

  test("a serf with only a tracked prompt (no .bandit prompt.md) still reads", async () => {
    const runner: any = await import(join(SRC, "runner.ts"));
    tracked("mute", "FROM-TRACKED mute\n");
    expect(runner.readSerfFolder(join(root, ".bandit", "serfs", "mute"), root).prompt).toBe("FROM-TRACKED mute\n");
  });

  test("runSerfOnCard renders the tracked prompt for the worker", async () => {
    const runner: any = await import(join(SRC, "runner.ts"));
    tracked("actor", "FROM-TRACKED actor: {{card.task}}\n");
    const cardDir = join(root, ".bandit", "board", "backlog", "c1");
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, "card.md"), "---\nid: c1\ntask: TASK-TEXT\n---\n# c1\n");
    const stub = join(root, "echo.sh");
    writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$1"\n');
    chmodSync(stub, 0o755);
    const r = await runner.runSerfOnCard({
      serfDir: join(root, ".bandit", "serfs", "actor"), cardDir, root,
      transport: { kind: "headless", command: stub, args: [] }, vars: {},
    });
    expect(r.run.output).toContain("FROM-TRACKED actor: TASK-TEXT");
    expect(r.run.output).not.toContain("FROM-BANDIT");
  });
});

describe("seed prompts-tracked: bandit prompts export", () => {
  test("copies every .bandit serf prompt into prompts/<serf>/prompt.md, byte for byte", () => {
    const r = cli("prompts", "export");
    expect(r.code).toBe(0);
    for (const name of ["master", "critic", "actor"]) {
      const dst = join(root, "prompts", name, "prompt.md");
      expect(existsSync(dst)).toBe(true);
      expect(readFileSync(dst, "utf-8")).toBe(readFileSync(join(root, ".bandit", "serfs", name, "prompt.md"), "utf-8"));
    }
    expect(existsSync(join(root, "prompts", "mute"))).toBe(false);
  });

  test("an existing tracked prompt is kept unless --force", () => {
    tracked("critic", "TRACKED-EDIT critic\n");
    expect(cli("prompts", "export").code).toBe(0);
    expect(readFileSync(join(root, "prompts", "critic", "prompt.md"), "utf-8")).toBe("TRACKED-EDIT critic\n");
    expect(readFileSync(join(root, "prompts", "actor", "prompt.md"), "utf-8")).toBe("FROM-BANDIT actor: {{card.task}}\n");
    expect(cli("prompts", "export", "--force").code).toBe(0);
    expect(readFileSync(join(root, "prompts", "critic", "prompt.md"), "utf-8")).toBe("FROM-BANDIT critic: {{card.task}}\n");
  });

  test("an unknown prompts subcommand is a usage error (exit 2)", () => {
    expect(cli("prompts", "bogus").code).toBe(2);
  });
});
