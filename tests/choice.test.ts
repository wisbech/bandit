import { describe, expect, test, afterEach } from "bun:test";
import { nullPort, type DecisionPort } from "../src/decisions";
import { systemOneAdapter } from "../src/evaluator-systemone";
import { routeDecision, ROUTE_OPTIONS, runLoop, readEvents } from "../src/loop";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seedDefaultFolders } from "./v30-helpers";

// Choice on the decision port: the systemone wire mapping, fail-closed on
// anything malformed, and the routing fallback that uses it.

const CFG = { evaluator: "systemone" as const, endpoint: "http://127.0.0.1:9999", timeoutMs: 50 };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function answering(body: unknown, seen?: { body?: any }) {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    if (seen) seen.body = JSON.parse(String(init.body));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

const OPTS = { proceed: "go on", amend: "retry amended" };

describe("systemone choose", () => {
  test("one choice question; probabilities mapped from answers.route", async () => {
    const seen: { body?: any } = {};
    answering({ answers: { route: { type: "choice", choice: "amend", probabilities: { proceed: 0.26, amend: 0.74 } } } }, seen);
    const p = await systemOneAdapter(CFG).choose("state text", "which?", OPTS);
    expect(p).toEqual({ proceed: 0.26, amend: 0.74 });
    expect(seen.body.state).toEqual({ body: "state text" });
    expect(seen.body.questions).toEqual({ route: { type: "choice", instructions: "which?", criteria: OPTS } });
  });

  test("malformed answers -> null", async () => {
    const port = systemOneAdapter(CFG);
    for (const probabilities of [undefined, null, [0.5], {}, { proceed: "0.5" }, { proceed: Number.NaN }, { unknown: 0.9 }, { toString: 0.9 }]) {
      answering({ answers: { route: { type: "choice", probabilities } } });
      expect(await port.choose("s", "i", OPTS)).toBeNull();
    }
    answering({ nothing: true });
    expect(await port.choose("s", "i", OPTS)).toBeNull();
  });

  test("timeout -> null (fail closed)", async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal?.addEventListener("abort", () => rej(new DOMException("The operation timed out.", "TimeoutError")));
    })) as unknown as typeof fetch;
    expect(await systemOneAdapter(CFG).choose("s", "i", OPTS)).toBeNull();
  });

  test("null port -> null", async () => {
    expect(await nullPort().choose("s", "i", OPTS)).toBeNull();
  });
});

describe("routeDecision — routing fallback", () => {
  function portAnswering(p: Record<string, number> | null, calls: string[] = []): DecisionPort {
    return { ...nullPort(), choose: async (state, _i, options) => { calls.push(state); expect(options).toEqual(ROUTE_OPTIONS); return p; } };
  }

  test("the DECISION line wins; the port is not asked", async () => {
    const calls: string[] = [];
    const r = await routeDecision(portAnswering({ escalate: 0.99 }, calls), "argument\nDECISION: amend");
    expect(r).toEqual({ decision: "amend", source: "line", probabilities: null });
    expect(calls).toHaveLength(0);
  });

  test("line missing: confident choice is taken", async () => {
    const calls: string[] = [];
    const p = { proceed: 0.1, amend: 0.6, reject: 0.1, specialist: 0.1, escalate: 0.1 };
    const r = await routeDecision(portAnswering(p, calls), "we should retry with a better plan");
    expect(r).toEqual({ decision: "amend", source: "choice", probabilities: p });
    expect(calls).toEqual(["we should retry with a better plan"]);
  });

  test("line missing: top label below ROUTE_MIN_P floors to escalate", async () => {
    const p = { proceed: 0.2, amend: 0.45, reject: 0.1, specialist: 0.15, escalate: 0.1 };
    expect(await routeDecision(portAnswering(p), "unclear")).toEqual({ decision: "escalate", source: "floor", probabilities: p });
  });

  test("line missing: null port (or no port) escalates", async () => {
    expect(await routeDecision(nullPort(), "unclear")).toEqual({ decision: "escalate", source: "floor", probabilities: null });
    expect(await routeDecision(null, "unclear")).toEqual({ decision: "escalate", source: "floor", probabilities: null });
  });
});

describe("routing consult in the loop", () => {
  test("reply without a DECISION line: consult.decision floor, card to review (the old null path)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bandit-choice-")));
    process.chdir(root);
    try {
      seedDefaultFolders(root);
      const cardDir = join(root, ".bandit", "board", "backlog", "nodecision");
      mkdirSync(cardDir, { recursive: true });
      writeFileSync(join(cardDir, "card.md"), "---\ncolumn: backlog\nid: nodecision\nverify: false\n---\n# nodecision\n- works\n");
      const stub = join(root, "stub.sh");
      writeFileSync(stub, [
        "#!/bin/sh",
        'if echo "$1" | grep -q "Grade the work"; then echo "VERDICT: fail\\nCONFIDENCE: 0.9\\nREASONING: red"; exit 0; fi',
        'case "$1" in *"CONSULT (routing)"*) echo "I am not sure what to do here.";; *) echo "work\\nVERIFICATION_COMMAND: false\\nVERIFICATION_EXIT_CODE: 1";; esac',
      ].join("\n"));
      chmodSync(stub, 0o755);
      await runLoop({ once: true, root, transport: { kind: "headless", command: stub, args: [] }, maxRetries: 1 });
      const ev = readEvents().find((e) => e.type === "consult.decision");
      expect(ev).toMatchObject({ card: "nodecision", thread: "route", decision: "escalate", source: "floor", probabilities: null });
      expect(existsSync(join(root, ".bandit", "board", "review", "nodecision", "card.md"))).toBe(true);
    } finally {
      process.chdir("/");
      rmSync(root, { recursive: true, force: true });
    }
  });
});
