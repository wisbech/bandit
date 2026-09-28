# Design — The summoned voice: spawning researchers into the consult thread

Status: DESIGN v2 (adopted; supersedes the "critic-only consult" restriction after the principal's duck.ai observation)
Date: 2026-09-28
Trigger: the principal's critique — the master↔critic consult is a Yes-Minister two-hander; the master hedges bets on its own proposal while actor and critic fumble around it. The compounding example: the bandit-harness design thread (master ↔ duck.ai ↔ assistant) — the best outputs of this project came from *summoning a voice with different knowledge into the conversation*, not from two fixed personas negotiating.

## 1. What's wrong with the two-hander

The consult thread (critic-deliberation-plan.md v3) has exactly two voices: master decides, critic argues. Two failure modes follow structurally:

1. **Critic-blind spots.** The critic knows what it knows. A plan about bandit algorithms, market microstructure, or a novel architecture needs a *domain* voice, not a better worded objection. The master↔addendum exchange worked because the addendum carried research the master didn't have.
2. **Single-perspective bargaining.** Two fixed personas converge on the *bargain between them*, not the truth. The duck.ai thread compounded because each new question imported fresh research — the conversation grew a new organ mid-flight.

The bandit literature itself says this (the duck.ai thread's own lesson, and the design doc's §7): **the criterion/knowledge generator must be independent of the policy being optimized.** Two standing serfs bargaining is a policy; a *summoned researcher with a fresh prompt and cited sources* is an instrument.

## 2. The design: consults can summon one domain voice

### 2.1 The SUMMON move (master's option inside any consult)

At any consult point, the master may summon **one** extra voice before deciding. The mechanism is the critic's existing DECISION line, extended by one word:

```
DECISION: proceed | amend | reject | specialist | escalate
SUMMON: <role-name>        ← optional; at most one per consult point
```

If SUMMON is present, the loop:
1. **Spawns a one-card serf** under `serfs/<parent>/children/consult-<role>-<ts>/` — full folder discipline (origin.md with the problem, the parent's motivation, the card), reusing `registerChild` (src/bandit.ts:236). The spawn is the *audit*, not a process leak.
2. **Runs one reply turn** (`runSerfReply`): the summoner's question + the thread so far + instruction to answer as a domain expert, free text, with sources/claims explicitly marked. The reply folds into `card/consult.md` as `**<role>:**` — same thread, third voice.
3. **Returns the decision** to whoever consults (the master still decides; the researcher's argument is in the room, not in charge).

### 2.2 Who may summon what

- **Plan consult:** master may SUMMON one researcher/architect (e.g. `researcher`, `architect`) on the plan's domain. This is the compounding case: the plan gets examined by someone whose *prompt* encodes domain knowledge, not just adversarial stance.
- **Stagnation consult:** SUMMON allowed when the same wall persisted — the domain voice asks "is this a wall or a doorway?" (this replaces the regex specialist trigger's *guess* with a *conversation*).
- **Routing consult:** no SUMMON (routing is the master's decision with the thread in front of it; a fourth voice adds latency, not information).
- **The actor may summon too** — via its own specialist-spawn trigger, which already exists (src/loop.ts:670) and now registers children properly. The actor's summons are execution-shaped (specialists), the master's are knowledge-shaped (researchers). Both land in the same children/ registry, both visible in the event log.

### 2.3 The serf identity (researchers/architects)

A summoned serf is a **fresh folder, fresh prompt, no persona debt** — created at summon time from a template that encodes the role:

```
researcher: "You research before you argue. Cite sources or mark claims as
unverified. You are advising the master — your argument must survive the
critic's rebuttal too."
architect:  "You design structures, not solutions. Propose the shape; the
loop's organs build it."
```

Prompts live in `.bandit/serfs/<role>/prompt.md` when the project defines them (evidence-gated: `bandit summon <role>` writes the default); the summoner names any role and the loop uses it if a prompt exists, else refuses with a clear event (`consult.summon_failed { reason: "no such serf" }`). **No implicit persona invention by the model.**

### 2.4 Compounding (the duck.ai lesson, mechanically)

The duck.ai thread produced the harness design *because each answer entered a shared document that later turns could quote*. The consult thread already has that property (append-only consult.md, threaded, prior thread folded into later openings — implemented in the muky62ac fix). The summon extends it: the researcher's reply joins the same file, so the *next* consult point (stagnation, routing) opens with the researcher's argument already in the room. Compounding = the thread, not the persona.

### 2.3 Goodhart boundary (unchanged, restated once)

The summoned voice advises; it never:
- touches the gate (no consult turns red green),
- grades anything (the seat's room),
- writes code (read-only by the capability profile, same as the critic),
- or becomes a standing organ (summons are per-consult, budget-counted, and each summon emits `consult.summoned { card, role, by }` for the refiner's ROI reading).

## 3. Build-now column

| Build | Notes |
|---|---|
| `SUMMON: <role>` parse + one-shot reply turn, folded into consult.md | the only mechanism change; everything else is prompt + docs |
| serf folder + registry via registerChild | audit trail free (bandit.ts:236 already correct) |
| `consult.summoned` event | refiner reads it with the other consult.* events |
| role templates at init (`researcher`, `architect`) | two files, prompt-only |

**Frozen (KISS ledger):** multi-summon (≥2 voices), voice-to-voice debate without master, researcher-initiated summons. Trigger: first production case where one summon visibly failed to resolve a dispute.

## 4. Cost

+1 reply turn per summon, bounded (≤1 per consult point, ≤2 consult points summon-capable). Budget-counted as all replies. The children/ registry makes the compound visible: over a week, the tree of who-argued-with-whom on which card is a file the refiner can read.