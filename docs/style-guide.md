# Style guide — the factory's face

Status: TOKENS + RULES (adopted from the isoquant.ai design audit; applies to every bandit render — watch, dossier, board, doctor, CLI output)
Date: 2026-09-28
Sources: isoquant.ai (extracted design tokens, below), OmO's wave view (information layout), bandit's own dossier grammar.

---

## 1. The tokens (bandit's own palette, from the logo — layout grammar learned from isoquant.ai)

The aesthetic in one line: **ink surfaces, bandit orange as the working accent, cream text, warm code, hairline borders, measured weight** — data presented as evidence, never decorated. The palette comes from our own logo (`docs/bandit-icon.png`: ink `#101818`, orange `#f89800`, cream `#f8f0e0`); the *layout grammar* (numbered sections, scarcity of accent, hierarchy by brightness) is learned from isoquant.ai and credited in the site's lineage section.

### 1.1 Color

| Token | Hex | ANSI approximation | Use |
|---|---|---|---|
| `ink` (surface) | `#101818` | `30`/`90` dim | backgrounds — the factory floor |
| `cream` (fg) | `#f8f0e0` | `37`/`97` | primary text |
| `cream-dim` (muted) | `#b9b4a8` | `90` | secondary text, timestamps, payload keys |
| `faint` | `#6e7a74` | `37` dim / `38;5;102` | labels, rules, the quiet layer |
| `orange` (accent) | `#f89800` | `33`/`1;33` | **work in flight** — the actor's marker, active state, the brand note |
| `ok` | `#6fae85` | `32` (green) | **success only** — gate green, converged, healthy |
| `danger` | `#c25b4e` | `31` | **failure only** — gate red, contradictions |
| `summon` | `#b58fd0` | `35` (magenta) | summoned voices only — the thread's third party |
| `paper` | `#f8f0e0` | `97` | code/tool output, data cells |

Orange vs green — the rule that keeps them honest: **orange means working, green means worked.** A card in flight is orange; a gate that passed is green; a failure is red; a summoned voice is magenta. Nothing else gets color.

Hard rules (the isoquant discipline):
- **No color without meaning.** A color says something: state, voice, or evidence class. Nothing is colored for decoration.
- **Accent green is scarce.** It marks the two or three things that matter being *right*. If everything is green, nothing is.
- **Hierarchy lives in brightness, not hue** — `fg` vs `muted` vs `faint` does 90% of the work.

### 1.2 Typography

| Element | Weight | Case | Notes |
|---|---|---|---|
| Section headers | 1 (bold) + dim color | UPPERCASE | `── WAVE ──…` hairline-underlined |
| Card/serf ids | normal fg | as-is | mono feel; truncate with `…` at fixed width |
| Voice tags (`master>`, `critic>`, `researcher>`) | dim, voice-colored | lowercase + `>` | right-anchored feel via alignment |
| Micro-labels (`stage`, `gate`, `round`) | 90 dim | lowercase | they are metadata, not headlines |
| Numbers/data | mono (terminal default) | as-is | right-where-they-matter, not in tables for decoration |

- **No ALL-CAPS content.** Uppercase is for micro-labels only (the `01 / CONNECT` pattern: `01 / CONNECT` → in bandit: `01 / TIMELINE` — number-slash-space, then the word).
- **Sentence case for prose.** Terminal voice: short declaratives, evidence cited in brackets.

### 1.3 Shape + space

- **radius 0.** No rounded boxes, no emoji-drawn frames beyond the single outer rule. The `╔══ ══╝` frame appears **once** per render (the outer frame) — sections use hairlines, not boxes.
- **Borders:** `1px solid #ffffff22`-equivalent → ANSI: dim (`90`) hairlines, 50-60 chars wide, always the same length per section.
- **Spacing:** 1 blank line between sections, 2-space indent per hierarchy level, 8-col indent for consult continuation lines. Whitespace is the primary separator (isoquant's `padding: 8/16/24/64` rhythm).
- **Density:** the whole render fits in ~30 lines. Compaction is a design virtue — the wave view must not grow with the board's history.

### 1.4 Voice (copy rules, the isoquant tone applied to bandit)

- Statements, not sales. "All four columns present", not "All systems go!"
- Evidence inline: `gate red (exit 2 · backticks stripped)` — the why rides with the what.
- Numbers as characters, not badges: `89 tests`, `0 fail`, `37 events today`.
- Absence is stated in parentheses, italic-feel, dim: `(no consult thread — no consults were opened for this card)`.

---

## 2. The bandit render map (component → tokens)

| Component | Tokens | Rule |
|---|---|---|
| Frame (`╔══ BANDIT ══╝`) | `36` dim cyan **once** | the only "box" on screen |
| Section headers | `1;37` + hairline | `── NAME ─────…` always same length |
| Agent rows (`● pid`) | `36` dot, `1;37` role, `90` details | one line per worker |
| Wave card row (`▸ id`) | orange `1;33` marker (in-flight = working), id padded, state dim | the wave is data, not decoration |
| Gate cell | `32` green / `31` red / `90` none | the only state-colored cells |
| Consult voices | master `36`, critic `90`, summoned `35` | voice identity is color identity |
| Events tail | `90` everything | the truth is quiet |
| Doctor checks | `✓`/`◐`/`✗` + same-color note | status marks, not progress bars |
| Dossier | headers `1;37`, evidence `97`, warnings `1;33` | ⚠ is earned, never routine |

### 2.1 The wave view (the OmO layout, isoquant tone)

```
╔══ BANDIT ═══════════════════════════════════════════╗
  ● pid 96730 · actor · opencode · model glm-5.3-flash:cloud

  01 / WAVE ────────────────────────────────────────
  ▸ probe-summon-mulbhhrz     stage trivial   role actor      gate red       2 out 355KB
    └ consult:
        master>  The actor produced a plan for review…
        critic>  The plan skips evidence collection… DECISION: amend
        researcher>  Per the bandit literature… (unverified: spawn mechanics)

  02 / BOARD ──────────────────────────────────────
  backlog 1 │ in-progress 1 │ review 1 │ done 5

  03 / EVENTS ─────────────────────────────────────
  14:19:57 specialist.spawned specialist=specialist-… via=master-consult
╚════════════════════════════════════════════════════╝
```

Numbered sections (`01 /`) are isoquant's move — the factory floor reads as an ordered instrument panel, not a log dump.

---

## 3. What we are NOT doing (anti-goals, KISS-compatible)

- **No TUI framework** (bubbletea/ink/charm) — hand-rolled ANSI, dependency-free, until a measured trigger (kiss §3: ≥3 live-updating cards make raw ANSI painful).
- **No web/desktop UI** — the files are the state; clients are disposable. A viewer is a frozen-column item.
- **No color themes / config surface for styling** — the tokens above are the theme. One voice.
- **No emoji, no badges, no ASCII art beyond the single frame.**

## 4. Implementation checklist (apply-once, then stop)

1. `watch.ts` — adopt the token map (§2), numbered sections, hairline lengths normalized.
2. `dossier.ts` — same tokens; `⚠` amber not red (red is for the gate only).
3. `cli.ts` (board/doctor/serf) — same tokens; doctor's `◐` stays for warnings.
4. Tests assert structure (ids, sections), never exact colors — color is presentation, not contract.