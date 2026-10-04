import { test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// The kernel's import rule (src/kernel/README.md): kernel files import only
// node builtins and each other. Nothing from decisions, evaluators, gauge,
// loop or refiner can reach the judge or the log.

const KERNEL = join(import.meta.dir, "..", "src", "kernel");

function specifiers(src: string): string[] {
  const out: string[] = [];
  for (const re of [/\bfrom\s+["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']/g, /\bimport\s+["']([^"']+)["']/g, /\brequire\s*\(\s*["']([^"']+)["']/g]) {
    for (const m of src.matchAll(re)) out.push(m[1]);
  }
  return out;
}

test("src/kernel/*.ts imports only node builtins and other kernel files", () => {
  const files = readdirSync(KERNEL).filter((f) => f.endsWith(".ts"));
  expect(files).toEqual(expect.arrayContaining(["card.ts", "judge.ts", "log.ts"]));
  const bad: string[] = [];
  for (const f of files) {
    for (const spec of specifiers(readFileSync(join(KERNEL, f), "utf-8"))) {
      const ok = spec.startsWith("node:") || (/^\.\/[\w-]+$/.test(spec) && existsSync(join(KERNEL, `${spec.slice(2)}.ts`)));
      if (!ok) bad.push(`${f}: ${spec}`);
    }
  }
  expect(bad).toEqual([]);
});

test("the rule catches a forbidden import", () => {
  expect(specifiers('import { askRoundGate } from "../decisions";\nconst x = await import("../loop");')).toEqual(["../decisions", "../loop"]);
});
