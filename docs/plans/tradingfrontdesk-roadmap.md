# Roadmap — TradingFrontDesk: backtest → demonstrate → paper → live

Status: ACTIVE roadmap (master/critic review) · Date: 2026-09-24
Governing objective (`.bandit/goal/goal.md`, unchanged): **maximize E[growth] subject to P(ruin) ≈ 0** — OOS CAGR primary, Sharpe ≥ 1.0 net, max drawdown ≤ 20%, robustness under cost-stress and jitter. The constitution (kill switch, risk caps, staleness gates, verify suite) is never tradeable for performance.

Owner path: **bandit drives this; the human escalates to their own account only at Phase 4.**

---

## 0. Where we actually are (audited 2026-09-24, no cherry-picks)

**Verified working (30/30 PASS on the verify suite):**
- Long/flat TSMOM engine (MOP 2012, sign-only — audit showed shorts/scaling/baseline hurt Sharpe on every symbol)
- Risk constitution: `RiskLimits` (10% daily loss halt, $10k position cap, 5 positions, $5k order cap), persistent `KillSwitch` (survives restarts, manual halts persist), staleness gates on data
- `typesafe_gate.py` — Jev regime veto, subtractive-only, fail-closed, hardening suite green
- Paper broker (`PaperBroker`) + IBKR interface (`IBKRBroker`, port 7497 paper / 7496 live); live mode opt-in via `TRADING_MODE` + CLI arg
- yfinance data layer with local CSV cache + synthetic fallback; watcher briefs running

**Honest current numbers (just re-run, 2015→today, costs included):**

| Symbol | Sharpe | CAGR | Max DD | Sharpe @2× cost | @5× cost |
|---|---|---|---|---|---|
| SPY | 0.796 | 11.9% | **−29.4%** | 0.79 | 0.78 |
| QQQ | 0.824 | 12.1% | −21.9% | 0.82 | 0.81 |
| AAPL | 0.672 | 9.1% | −25.8% | 0.67 | 0.66 |
| MSFT | 0.832 | 11.8% | −26.7% | 0.83 | 0.82 |
| NVDA | **1.254** | 19.4% | −21.8% | 1.25 | 1.25 |

**Verdict against the convergence definition: NOT MET.** Only NVDA clears Sharpe ≥ 1.0; *every* symbol breaches the ≤20% drawdown floor. Cost-robustness is excellent (Sharpe barely moves at 5× costs — the edge is real, not fee-eaten). The strategy makes money; it does not yet survive the risk floor we set. **This is precisely the gap the roadmap must close before paper trades.**

**Known debts (must clear in Phase 0):**
- Both loops died in the Sep 18 crash; 008b stranded mid-plan in `in-progress/`; 001/002/004/007 in `review/` from the pre-fix 0-byte-output bug; `run.lock` stale (auto-clears on start)
- Card 002 (**walk-forward**) is the load-bearing unfinished work — the numbers above are single-pass in-sample-adjacent, not the OOS the goal demands

---

## 1. The four gates (each is a bandit phase; each has an explicit exit test)

### Phase A — Backtest integrity & strategy improvement (current → weeks 1–3)
**Goal:** meet the convergence definition honestly, on walk-forward OOS, not single-pass.

Cards to file:
- **A1 — Walk-forward completion (revive card 002).** Anchored walk-forward: refit each year, trade next year, 2015→2026 stitched OOS. Acceptance: stitched OOS report per symbol + pooled; cost-stress 2×/5×; parameter jitter ±20% (5 seeds). *Exit: stitched OOS table exists in the card; no symbol passes that didn't in-sample.*
- **A2 — Drawdown attack.** The 20% floor is the binding constraint. Candidate levers (in goal-order, subtractive-first): vol-target reduction (0.15 → 0.10–0.12), regime filter (the already-built `typesafe_gate` vetoed into the backtest), per-symbol drawdown-aware sizing, universe diversification (add non-correlated ETF legs). *Exit: maxDD ≤ 20% on stitched OOS with CAGR not worse than −20% of current.*
- **A3 — Anti-overfit discipline.** Every improvement card must show: in-sample vs OOS delta, jitter survival, and a no-look-ahead attestation (the verify suite already checks look-ahead — keep it passing). *Exit: no card merged with only in-sample evidence.*

**Phase exit test:** stitched walk-forward OOS meets *all four* goal clauses. Not before.

### Phase B — Demonstration (weeks 3–5, no money at risk)
- **B1 — Daily demonstration run:** agent in paper mode runs the full cycle each market day: fetch (staleness-gated) → signals → sizing → Jev veto → paper orders → heartbeat. Runs under the *factory loop*: a card per day is overkill — the daily run writes a report file; bandit processes improvement cards in parallel.
- **B2 — Demonstration ledger:** every day, one markdown entry: signals, veto decision (with Jev provenance), paper P&L, drawdown vs kill-switch line, and *what the strategy would have done differently*. This is the "demonstrate strategies for making money and managing risk" requirement, in writing, daily.
- **B3 — Risk behavior demonstrated in the wild:** at least one deliberate risk event shown handled: a daily-loss-limit trip (simulated input spike), a data-staleness gate holding trading flat, a kill-switch persistence check across restart. *Exit: the kill switch tripped, flattened, and stayed halted across a restart — on paper.*
- **B4 — Weekly critic review:** bandit's critic reviews each week's demonstration ledger against the goal; failures become cards. The factory improves the desk from its own history — that's the refiner's job.

**Phase exit:** 20 consecutive trading days paper-run, zero unhandled exceptions, daily ledger complete, drawdown never breached 20% intraday, Sharpe-to-date ≥ 0.8 (paper slippage is real even when fills are instant).

### Phase C — Paper-with-broker (weeks 5–8)
- **C1 — IBKR paper account:** connect TWS/gateway on 7497; the *same* agent loop, real market data pipeline, real fills with latency. The `PaperBroker` → `IBKRBroker` seam already exists.
- **C2 — Ops hardening:** TWS nightly-reset handling (the kill-switch doc already anticipates it), reconnect storms, partial fills, market holidays. Each becomes a verify-suite case.
- **C3 — 40 consecutive trading days** paper-live through IBKR, daily ledger, weekly critic review. Track *fill quality vs backtest assumptions* — if real fills cost > 3bps, the cost model updates and the backtest re-runs (honest numbers only).
- *Exit: 40 days, Sharpe-to-date ≥ 0.8 on paper, drawdown floor never breached, cost model validated against real fills.*

### Phase D — Live, own account (only after C3, and only with the principal's explicit go)
- **D0 — Sizing cap**: first live month at ≤ 20% of intended capital; kill switch limits unchanged.
- **D1 — Live monitoring**: same daily ledger, plus a morning pre-flight (gateway up, data fresh, kill switch armed) and evening reconciliation (fills vs orders).
- **D2 — Scale-up ladder**: only after each month with drawdown < 20% and realized Sharpe in line with paper. Any kill-switch trip = automatic step back down one rung.

### What refuses entry to each phase (the hard gates)
- Verify suite green (currently 30/30)
- Goal convergence criteria on *stitched walk-forward OOS*, not in-sample
- Kill-switch trip + restart persistence demonstrated (B3) before any broker connection
- No card may weaken the constitution — refused by the critic, per the goal's own text

## 2. What bandit does each phase (the factory's job)

- **Loop restarts now** — stale lock auto-clears; stranded 008b resumes; the review-column cards (001/002/004/007) are re-run *after* A1 lands (their pre-fix failures were plumbing, not judgment)
- **Cards per phase** filed as the phase opens, not all at once — the board stays honest
- **Laya/decisions port** (now implemented) answers the demonstrability question on every gate check: "does this output demonstrate the acceptance criteria?" — cheap, local, fail-closed
- **Refiner cadence**: failure signatures (verification_red ×2, plumbing) trigger factory self-improvement as usual
- **Daily rhythm in Phase B/C**: watcher brief (08:00 UTC) → Jev regime check (pre-open) → agent cycle → evening ledger entry → weekly critic review card

## 3. The money question, stated plainly

"Make money every day" is not the goal the factory optimizes — **and should not be**. The goal text (correctly) optimizes long-horizon risk-adjusted growth because *every-day* profit is a P(ruin)=1 strategy: maximizing daily P(win) means selling tail risk until the drawdown floor is breached. What the desk *will* demonstrate daily: the strategy's edge (signals + veto + sizing), risk discipline (caps, kill switch, staleness), and honest accounting (winning days, losing days, and the drawdown path between). The daily *demonstration* is of process; the money comes from the expectancy over months, at account scale only after Phases A–C.

## 4. First cards to file (next session)

1. **A1 walk-forward** — unblock the existing 002 card (it's in review with pre-fix plumbing failure; re-run post-fix, acceptance = stitched OOS report)
2. **A2 drawdown** — vol-target + gate-in-backtest experiment card, acceptance = maxDD ≤ 20% on stitched OOS at Sharpe ≥ 0.8
3. **B3 kill-switch drill** — demonstrate trip/persist/resume on paper; verify-suite case added
4. **Housekeeping** — resolve 007 (deploy/CI plan) after A1; re-triage 001 (data layer) against the current data.py (cache + synthetic fallback may already satisfy it)

## 5. References

- `.bandit/goal/goal.md` — the objective (unchanged; it is the constitution)
- `desk/plans/typesafe-integration-plan.md` — Jev gate, subtract-only, fail-closed
- `docs/plans/laya-decision-model-plan.md` — the decisions port (implemented) demonstrability question
- bandit docs: [architecture.md](../architecture.md) · [appropriations.md](../appropriations.md)