import type { DecisionConfig, DecisionPort, GaugeAnswer, GaugeQuestion } from "./decisions";

// evaluator-systemone.ts — adapter for the SystemOne wire protocol
// (POST /v1/systemone): served identically by laya-serve (local, Apache-2.0)
// and TypeSafe's hosted Jev. Point `endpoint` at either; bandit can't tell
// the difference and doesn't care.
//
// The adapter OWNS the translation between bandit's question vocabulary and
// the wire format. Swap evaluators by repointing the endpoint — or by writing
// a different adapter and registering it under another name.

// The state is cut to this many chars before it goes on the wire.
export const STATE_CEILING = 8_000;

type RawAnswer = { noul?: unknown; answer?: unknown; probability?: unknown; probabilities?: unknown; score?: unknown };

const unit = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
};

// Wire answer -> bandit's normalised answer, or null if malformed.
// noul:   {"noul":0.71}
// choice: {"choice":"lesson","probabilities":{"lesson":0.88,...}} — every key a given label, every value finite
// score:  {"score":1.82,"probabilities":{"0":..}} (expected index over the ordered labels, live laya-serve)
//         or {"answer"|"probability": 0..1} (the shape failureSimilarity was written against)
export function normalise(q: GaugeQuestion, a: RawAnswer | undefined): GaugeAnswer | null {
  if (!a || typeof a !== "object") return null;
  if (q.type === "noul") {
    const p = unit(a.noul ?? a.probability);
    return p === null ? null : { p };
  }
  if (q.type === "score") {
    const n = Array.isArray(q.criteria) ? q.criteria.length : 0;
    const s = typeof a.score === "number" && n >= 2 ? a.score / (n - 1) : (a.answer ?? a.probability);
    const value = unit(s);
    return value === null ? null : { value };
  }
  const p = a.probabilities;
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const labels = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria ?? {});
  const entries = Object.entries(p as Record<string, unknown>);
  if (entries.length === 0) return null;
  if (!entries.every(([k, v]) => labels.includes(k) && typeof v === "number" && Number.isFinite(v))) return null;
  const probabilities = Object.fromEntries(entries) as Record<string, number>;
  const label = entries.reduce((best, [k, v]) => ((v as number) > probabilities[best] ? k : best), entries[0][0]);
  return { label, probabilities };
}

export function systemOneAdapter(cfg: DecisionConfig): DecisionPort {
  const endpoint = cfg.endpoint.replace(/\/+$/, "");
  const defaultTimeoutMs = cfg.timeoutMs ?? 2_000;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = `Bearer ${cfg.apiKey}`;

  async function post(
    state: string,
    questions: Record<string, GaugeQuestion>,
    timeoutMs = defaultTimeoutMs,
  ): Promise<Record<string, RawAnswer> | null> {
    const bounded = state.length > STATE_CEILING ? state.slice(0, STATE_CEILING) : state;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(endpoint + "/v1/systemone", {
          method: "POST",
          headers,
          body: JSON.stringify({ state: { body: bounded }, questions, ...(cfg.model ? { model: cfg.model } : {}) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        const json = await res.json();
        return json?.answers && typeof json.answers === "object" ? json.answers : null;
      } catch (e) {
        const networkError = /fetch|network|ECONN|timed?\s?out|abort/i.test(String(e));
        if (attempt === 1 || !networkError) return null;
      }
    }
    return null;
  }

  async function ask(state: string, questions: Record<string, GaugeQuestion>, timeoutMs?: number) {
    const raw = await post(state, questions, timeoutMs);
    if (!raw) return null;
    const out: Record<string, GaugeAnswer> = {};
    for (const [id, q] of Object.entries(questions)) {
      const a = normalise(q, Object.hasOwn(raw, id) ? raw[id] : undefined);
      if (!a) return null;
      out[id] = a;
    }
    return out;
  }

  const noul = async (state: string, id: string, instructions: string): Promise<number | null> => {
    const a = (await ask(state, { [id]: { type: "noul", instructions } }))?.[id];
    return a && "p" in a ? a.p : null;
  };

  return {
    ask,

    demonstrates(acceptance, verificationOutput) {
      return noul(
        `Acceptance criteria:\n${acceptance}\n\nVerification output:\n${verificationOutput}`,
        "demonstrates",
        "Does this verification output actually demonstrate that the acceptance criteria are met?",
      );
    },

    vacuous(command) {
      return noul(
        `Verification command: ${command}`,
        "vacuous",
        "Is this verification command vacuous — one that would pass even if no work had been done (e.g. `true`, `echo`, a check that doesn't reference the deliverable)?",
      );
    },

    // Left on the raw wire under the freeze: live laya-serve answers score
    // questions with `score` (expected index), not answer/probability, so this
    // reads null against it today. normalise() handles both; switching this
    // over changes the loop's stagnation signal — a decision for the readout.
    async failureSimilarity(previous, current) {
      const answers = await post(
        `Previous round failure:\n${previous}\n\nThis round failure:\n${current}`,
        { similarity: { type: "score", instructions: "How similar are these two failure descriptions?", criteria: ["different problems", "related", "the same failure"] } },
      );
      const a = answers?.similarity;
      if (!a) return null;
      return unit(a.answer ?? a.probability);
    },

    async choose(state, instructions, options) {
      const a = (await ask(state, { route: { type: "choice", instructions, criteria: options } }))?.route;
      return a && "probabilities" in a ? a.probabilities : null;
    },
  };
}
