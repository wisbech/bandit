import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { runLoop } from "../src/loop";
import { readLedger } from "../src/confidence";
import { seedDefaultFolders } from "./v30-helpers";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Freeze fix 7: the lever id is derived from the lever, not the card.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bandit-fixes-lever-"));
  process.chdir(root);
  seedDefaultFolders(root);
});

afterEach(() => {
  process.chdir("/");
  rmSync(root, { recursive: true, force: true });
});

function seedCard(id: string, body: string, extraFrontmatter = ""): string {
  const cardDir = join(root, ".bandit", "board", "backlog", id);
  mkdirSync(cardDir, { recursive: true });
  writeFileSync(join(cardDir, "card.md"), `---\ncolumn: backlog\nid: ${id}\ntitle: ${id}\n${extraFrontmatter}---\n# ${id}\n${body}`);
  return cardDir;
}

function writeStub(name: string, body: string): string {
  const p = join(root, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

function greenPassTransport(): string {
  return writeStub("stub-green.sh", [
    "#!/bin/sh",
    'echo "work done\\nVERIFICATION_COMMAND: true\\nVERIFICATION_EXIT_CODE: 0\\nVERIFICATION_OUTPUT: ok\\nVERDICT: pass\\nCONFIDENCE: 0.9\\nREASONING: fine"',
  ].join("\n"));
}

describe("fix 7: lever id comes from the lever, not the card", () => {
  test("two cards sharing a ## Lever accumulate pulls on one claim; frontmatter lever wins", async () => {
    const lever = "## Lever\nPooled risk sizing across correlated positions\n";
    seedCard("008-alpha", `# card\n- works\n\n${lever}`);
    seedCard("010-beta", `# card\n- works\n\n${lever}`);
    seedCard("011-gamma", "# card\n- works\n", "lever: pooled-risk-sizing\n");
    await runLoop({ once: true, root, transport: { kind: "headless", command: greenPassTransport(), args: [] }, maxRetries: 1 });
    const ids = [...readLedger(root).keys()].filter((id) => id.startsWith("lever:"));
    const shared = ids.filter((id) => id !== "lever:pooled-risk-sizing");
    expect(shared.length).toBe(1);
    expect(readLedger(root).get(shared[0])!.pulls).toBe(2);
    expect(ids).toContain("lever:pooled-risk-sizing");
    expect(ids.some((id) => /008|010|011/.test(id))).toBe(false);
  }, 20_000);
});
