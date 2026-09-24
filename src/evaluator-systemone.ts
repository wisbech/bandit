import type { DecisionConfig, DecisionPort } from "./decisions";

// evaluator-systemone.ts — adapter for the SystemOne wire protocol
// (POST /v1/systemone): served identically by laya-serve (local, Apache-2.0)
// and TypeSafe's hosted Jev. Point `endpoint` at either; bandit can't tell
// the difference and doesn't care.
//
// The adapter OWNS the translation between bandit's question vocabulary and
// the wire format. Swap evaluators by repointing the endpoint — or by writing
// a different adapter and registering it under another name.

export function systemOneAdapter(cfg: DecisionConfig): DecisionPort {
  const endpoint = cfg.endpoint.replace(/\/+$/, "");
  const timeoutMs = cfg.timeoutMs ?? 2_000;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = `Bearer ${cfg.apiKey}`;

  async function ask(
    state: string,
    questions: Record<string, { type: string; instructions: string; criteria?: unknown }>,
  ): Promise<Record<string, { noul?: number; answer?: string | number; probability?: number }> | null> {
    const bounded = state.length > 8_000 ? state.slice(0, 8_000) : state;
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

  function prob(a: { noul?: number; probability?: number } | undefined): number | null {
    if (!a) return null;
    const p = a.noul ?? a.probability;
    if (p === undefined) return null;
    const v = Number(p);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
  }

  return {
    async demonstrates(acceptance, verificationOutput) {
      const answers = await ask(
        `Acceptance criteria:\n${acceptance}\n\nVerification output:\n${verificationOutput}`,
        {
          demonstrates: { type: "noul", instructions: "Does this verification output actually demonstrate that the acceptance criteria are met?" },
        },
      );
      return prob(answers?.demonstrates);
    },

    async vacuous(command) {
      const answers = await ask(
        `Verification command: ${command}`,
        { vacuous: { type: "noul", instructions: "Is this verification command vacuous — one that would pass even if no work had been done (e.g. `true`, `echo`, a check that doesn't reference the deliverable)?" } },
      );
      return prob(answers?.vacuous);
    },

    async failureSimilarity(previous, current) {
      const answers = await ask(
        `Previous round failure:\n${previous}\n\nThis round failure:\n${current}`,
        { similarity: { type: "score", instructions: "How similar are these two failure descriptions?", criteria: ["different problems", "related", "the same failure"] } },
      );
      const a = answers?.similarity;
      if (!a) return null;
      const v = Number(a.answer ?? a.probability);
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
    },
  };
}