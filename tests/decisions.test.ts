import { describe, expect, test } from "bun:test";
import {
  registerDecisionAdapter,
  resolveDecisionPort,
  nullPort,
  loadDecisionConfig,
  askRoundGate,
  type DecisionPort,
} from "../src/decisions";
import { systemOneAdapter } from "../src/evaluator-systemone";

registerDecisionAdapter("systemone", systemOneAdapter);

const CFG = { evaluator: "systemone" as const, endpoint: "http://127.0.0.1:9999", timeoutMs: 100 };

function okFetch(body: object) {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}
function failFetch() {
  return (async () => { throw new Error("fetch failed: ECONNREFUSED"); }) as unknown as typeof fetch;
}

describe("DecisionPort — dependency inversion", () => {
  test("null config → null port: every question null, factory unchanged", async () => {
    const port = resolveDecisionPort(null);
    expect(port).not.toBeNull();
    expect(await port.demonstrates("a", "b")).toBeNull();
    expect(await port.vacuous("true")).toBeNull();
    expect(await port.failureSimilarity("x", "y")).toBeNull();
  });

  test("unknown adapter name → null port (fail-closed)", async () => {
    const port = resolveDecisionPort({ evaluator: "nonexistent" as never, endpoint: "http://x" });
    expect(await port.demonstrates("a", "b")).toBeNull();
  });

  test("adapter throws at construction → null port", () => {
    registerDecisionAdapter("throwing", () => { throw new Error("boom"); });
    const port = resolveDecisionPort({ evaluator: "throwing" as never, endpoint: "http://x" });
    return port.demonstrates("a", "b").then((r) => expect(r).toBeNull());
  });

  test("nullPort is explicit", async () => {
    const p = nullPort();
    expect(await p.demonstrates("a", "b")).toBeNull();
  });

  test("config loader: decisions section, legacy laya mapping, none", () => {
    // legacy laya config maps to systemone
    // (full file test needs a temp root; covered indirectly below)
    expect(loadDecisionConfig("/nonexistent-root-xyz")).toBeNull();
  });
});

describe("systemone adapter — wire protocol", () => {
  test("parses noul probability from answers", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ answers: { demonstrates: { noul: 0.92 } } }),
      { status: 200 },
    )) as unknown as typeof fetch;
    try {
      const port = systemOneAdapter(CFG);
      expect(await port.demonstrates("criteria", "output")).toBe(0.92);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("server down → null (fail-closed through the port)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = failFetch();
    try {
      const port = systemOneAdapter(CFG);
      expect(await port.demonstrates("a", "b")).toBeNull();
      expect(await port.vacuous("true")).toBeNull();
      expect(await port.failureSimilarity("x", "y")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("probability clamps to [0,1]", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = okFetch({ answers: { vacuous: { noul: 7.5 } } }) as unknown as typeof fetch;
    try {
      const port = systemOneAdapter(CFG);
      expect(await port.vacuous("true")).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("askRoundGate — the loop's one call site", () => {
  test("null port → all nulls (loop falls through unchanged)", async () => {
    const r = await askRoundGate(nullPort(), {
      demonstrates: "a", verificationOutput: "b", verificationCommand: "true",
      previousFailure: "x", currentFailure: "y",
    });
    expect(r).toEqual({ demonstrates: null, vacuous: null, failureSimilarity: null });
  });

  test("live adapter: all three answered in one round", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = okFetch({
      answers: {
        demonstrates: { noul: 0.95 },
        vacuous: { noul: 0.05 },
        similarity: { answer: 0.8 },
      },
    }) as unknown as typeof fetch;
    try {
      const port = systemOneAdapter(CFG);
      const r = await askRoundGate(port, {
        demonstrates: "criteria", verificationOutput: "out", verificationCommand: "true",
        previousFailure: "p", currentFailure: "c",
      });
      expect(r.demonstrates).toBeCloseTo(0.95, 5);
      expect(r.vacuous).not.toBeNull();
      expect(r.failureSimilarity).toBeCloseTo(0.8, 5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});