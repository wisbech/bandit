import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readEvents } from "./kernel/log";

// dossier.ts — `bandit card <id>`: the card dossier (visibility plan §3.1).
// A pure projection over existing state: the event log, the card folder,
// .bandit/grading/, consult.md. No writes, no decisions — a reader over
// files that already exist. Every section cites the file it came from.

// ── TIMELINE (events for this card, jsonl → readable lines) ──

// Payload keys rendered per event type; unknown types show what they have.
const TIMELINE_KEYS: Record<string, string[]> = {
  "card.created": ["title"],
  "card.moved": ["to"],
  "pipeline.selected": ["pipeline"],
  "round.started": ["round"],
  "verification.green": ["command"],
  "verification.red": ["command"],
  "gate.selfverify": ["reported", "actual"],
  "critic.verdict": ["verdict", "confidence", "plumbing"],
  "critic.repair": ["turn"],
  "critic.bypass": ["reason"],
  "consult.opened": ["thread"],
  "consult.turn": ["by", "bytes"],
  "consult.decided": ["decision", "thread"],
  "consult.routed": ["decision"],
  "consult.failed": ["thread", "reason"],
  "converged": ["round"],
  "card.completed": [],
  "task.failed": ["reason", "attempts"],
  "card.requeued": ["to", "reason", "requeues"],
  "card.amend_limit": ["requeues", "limit"],
  "grader.gate_contradiction": ["round", "graderConfidence"],
  "plan.started": [],
  "plan.finished": [],
  "plan.rejected": ["via"],
  "specialist.spawned": ["specialist", "capability", "via"],
  "transport.red": ["emptyAttempts"],
  "transport.retried": ["emptyAttempts", "recovered"],
  "transport.empty_output": ["attempt", "bytes"],
};

function timelineLine(e: Record<string, unknown>): string {
  const ts = String(e.ts ?? "").slice(11, 19); // HH:MM:SS (Z)
  const type = String(e.type ?? "?");
  const keys = TIMELINE_KEYS[type] ?? Object.keys(e).filter((k) => !["type", "ts", "card"].includes(k));
  const parts = keys
    .filter((k) => e[k] !== undefined && e[k] !== null)
    .map((k) => {
      let v = String(e[k]).replace(/\s+/g, " ");
      if (v.length > 72) v = v.slice(0, 69) + "…";
      return `${k}=${v}`;
    });
  return `  ${ts}  ${type}${parts.length ? `  ${parts.join(" · ")}` : ""}`;
}

// ── CONSULT THREAD → CHAT TRANSCRIPT (OpenCode transcript aesthetic) ──

// consult.md is "**by:**\n\n<text>\n\n" turns (loop.ts appendConsultTurn).
// Render as a chat: master right-margin tag, critic plain, decision lines
// highlighted. The DECISION line is the only parseable artifact — keep it.
function renderConsultChat(raw: string): string[] {
  const lines: string[] = [];
  // split with a capture group interleaves: [pre, "master", text, "critic", text, …]
  const turns = raw.split(/\*\*(master|critic):\*\*/i);
  for (let i = 1; i < turns.length; i += 2) {
    const by = turns[i].trim().toLowerCase();
    const text = (turns[i + 1] ?? "").trim();
    if (!["master", "critic"].includes(by)) continue; // header + non-turn noise
    for (const line of text.split("\n")) {
      const t = line.trimEnd();
      if (/^DECISION:/i.test(t.trim())) {
        lines.push(`    ${color("1;33", t.trim())}`);
      } else if (t === "") {
        lines.push("");
      } else {
        lines.push(`    ${by === "master" ? color("36", "> ") : color("90", "")}${t}`);
      }
    }
    lines.push("");
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function color(code: string, s: string): string {
  return `\x1b[${code}m${s}\x1b[0m`;
}

// ── GRADING (per-round verdicts from .bandit/grading/) ──
// Track-record files: <card>.md is the latest verdict; <card>.seat-*.md are
// the per-seat runs. Round attribution comes from critic.verdict events (each
// carries the round) joined to the track-record file.

interface GradingLine {
  round: number | null;
  verdict: string;
  confidence: string;
  file: string;
}

function readGradingVerdict(path: string): GradingLine | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const verdict = raw.match(/VERDICT:\s*(\S+)/i)?.[1] ?? "?";
    const confidence = raw.match(/CONFIDENCE:\s*([\d.]+)/i)?.[1] ?? "?";
    return { round: null, verdict, confidence, file: path };
  } catch {
    return null;
  }
}

function gradingLines(root: string, cardId: string, events: Record<string, unknown>[]): GradingLine[] {
  const gd = join(root, ".bandit", "grading");
  const out: GradingLine[] = [];
  // Round attribution: critic.verdict events carry { round, verdictPath }.
  const byRound = new Map<number, { verdict: string; confidence: number }>();
  for (const e of events) {
    if (e.type === "critic.verdict" && e.round !== undefined) {
      byRound.set(Number(e.round), { verdict: String(e.verdict), confidence: Number(e.confidence) });
    }
  }
  // Per-round verdicts from events, each citing its source: the round's own
  // verdictPath event payload when present, else the canonical track record.
  const canonical = join(gd, `${cardId}.md`);
  for (const [round, v] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
    const perRound = [...events].reverse().find((e) => e.type === "critic.verdict" && Number(e.round) === round && e.verdictPath !== undefined);
    const file = perRound ? String(perRound.verdictPath) : canonical;
    out.push({ round, verdict: v.verdict, confidence: v.confidence.toFixed(2), file });
  }
  // Canonical track-record file (.bandit/grading/<card>.md) — the latest
  // verdict. Only shown standalone when no per-round events cover it.
  if (byRound.size === 0 && existsSync(canonical)) {
    const line = readGradingVerdict(canonical);
    if (line) out.push(line);
  }
  // Seat runs (repair turns) — the grader's plumbing history.
  try {
    for (const f of readdirSync(gd).filter((f) => f.startsWith(`${cardId}.seat-`) && f.endsWith(".md")).sort()) {
      const line = readGradingVerdict(join(gd, f));
      if (line) out.push({ ...line, round: null, file: join(".bandit", "grading", f) });
    }
  } catch {}
  return out;
}

// ── ARTIFACTS (card folder contents with sizes) ──

interface Artifact {
  rel: string;
  bytes: number;
  note?: string;
}

function artifactNote(rel: string): string | undefined {
  if (rel === "card.md") return "the card itself";
  if (rel === "plan.md") return "plan phase output";
  if (rel === "consult.md") return "master↔critic thread (rendered above)";
  if (rel === "gates.json") return "gate fingerprints (repeat-failure memory)";
  if (rel === "verification-output.log") return "self-verified gate output";
  if (rel.startsWith("outputs/")) return "transport run output";
  if (rel.startsWith("observations/")) return "packed observation archive";
  return undefined;
}

// Recursive byte/file count for folding a whole subtree onto one line.
function treeSize(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else {
        bytes += st.size;
        files += 1;
      }
    }
  };
  try {
    walk(dir);
  } catch {}
  return { bytes, files };
}

function listArtifacts(cardDir: string, root: string): { rel: string; bytes: number; note?: string }[] {
  const out: { rel: string; bytes: number; note?: string }[] = [];
  const scratch: { bytes: number; files: number } | null = probeScratch(join(cardDir, ".bandit", "tmp"));
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        // The harness's own scratch (runner.ts redirects TMPDIR into the card:
        // .bandit/tmp with bunx caches, dylibs, agent probes) is ephemeral
        // plumbing, not card state — 600+ files of bunx cache buried the
        // real artifacts in dogfood. Folded to one counted line: nothing
        // invisible, nothing drowning.
        if (name === ".bandit") continue;
        walk(p, prefix + name + "/");
      } else {
        const rel = prefix + name;
        out.push({ rel, bytes: st.size, note: artifactNote(rel) });
      }
    }
  };
  walk(cardDir, "");
  if (!scratch) return out.map((a) => ({ ...a, rel: relative(root, join(cardDir, a.rel)) }));
  const folded: { rel: string; bytes: number; note?: string } = {
    rel: relative(root, join(cardDir, ".bandit", "tmp")) + "/",
    bytes: scratch.bytes,
    note: `harness scratch (TMPDIR redirect) — ${scratch.files} file(s), folded`,
  };
  return [...out.map((a) => ({ ...a, rel: relative(root, join(cardDir, a.rel)) })), folded];
}

// Presence probe BEFORE the walk: the closure assignment inside `walk` never
// survives to the return check (TS narrows `scratch` to never after the
// closure), so the fold decision reads the filesystem directly instead.
function probeScratch(path: string): { bytes: number; files: number } | null {
  if (!existsSync(path)) return null;
  const s = treeSize(path);
  return s.files > 0 ? s : null;
}

// ── THE DOSSIER ──

export function renderCardDossier(root: string, cardId: string): string {
  const lines: string[] = [];
  const cardDir = findCardDir(root, cardId);
  const events = readEvents(root).filter((e) => e.card === cardId);
  lines.push(`╔══ CARD DOSSIER ═══════════════════════════════════════`);
  lines.push(`  id: ${cardId}`);

  // ── IDENTITY (card.md) ──
  if (cardDir) {
    const raw = readFileSync(join(cardDir, "card.md"), "utf-8");
    const title = raw.match(/^title:\s*(.+)$/m)?.[1] ?? cardId.split("-").slice(0, -1).join(" ");
    const column = raw.match(/^column:\s*(\S+)$/m)?.[1] ?? "?";
    lines.push(`  title: ${title}`);
    lines.push(`  column: ${column}`);
    lines.push("");
    lines.push(color("1;37", "── TASK (card.md) ────────────────────────────────"));
    const noFm = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
    const taskText = (noFm.match(/## Task\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? noFm).trim();
    for (const l of taskText.split("\n").slice(0, 12)) lines.push(`  ${l}`);
  } else {
    lines.push(`  (no card folder found for this id — rendering from events only)`);
  }
  lines.push("");

  // ── TIMELINE (.bandit/events/*.jsonl) ──
  lines.push(color("1;37", "── TIMELINE (.bandit/events/ — events for this card) ──"));
  if (events.length === 0) {
    lines.push("  (no events for this card)");
  } else {
    for (const e of events) lines.push(timelineLine(e));
  }
  lines.push("");

  // ── CONSULT THREAD (card/consult.md → chat transcript) ──
  lines.push(color("1;37", "── CONSULT (card/consult.md) ─────────────────────"));
  const consultPath = cardDir ? join(cardDir, "consult.md") : null;
  if (consultPath && existsSync(consultPath)) {
    const chat = renderConsultChat(readFileSync(consultPath, "utf-8"));
    if (chat.length === 0) lines.push("  (empty thread)");
    else for (const l of chat) lines.push(l);
  } else {
    lines.push("  (no consult thread — no consults were opened for this card)");
  }
  lines.push("");

  // ── GRADER VERDICTS (.bandit/grading/<card>.md + critic.verdict events) ──
  lines.push(color("1;37", "── GRADER (.bandit/grading/ + critic.verdict events) ──"));
  // Flag grader/gate contradictions loudly: a seat pass at a red gate is the
  // seat's fiction, recorded so calibration becomes measurable (kiss §3).
  for (const e of events) {
    if (e.type === "grader.gate_contradiction") {
      lines.push(`  ⚠ contradiction round ${e.round}: seat passed (conf ${e.graderConfidence}) while gate was RED — seat confidence is not evidence`);
    }
  }
  const grading = gradingLines(root, cardId, events as unknown as Record<string, unknown>[]);
  const roundVerdicts = grading.filter((g) => g.round !== null);
  if (roundVerdicts.length === 0 && !existsSync(join(root, ".bandit", "grading", `${cardId}.md`))) {
    lines.push("  (no grader verdicts — card not yet graded)");
  } else {
    for (const g of roundVerdicts) {
      const conf = g.confidence === "?" ? "" : ` (${g.confidence})`;
      lines.push(`  round ${g.round}: ${g.verdict}${conf}  [${relative(root, g.file)} + events]`);
    }
    for (const g of grading.filter((x) => x.round === null && !x.file.endsWith(`${cardId}.md`))) {
      const conf = g.confidence === "?" ? "" : ` (${g.confidence})`;
      lines.push(`  seat run: ${g.verdict}${conf}  [${relative(root, g.file)}]`);
    }
    const canonical = join(root, ".bandit", "grading", `${cardId}.md`);
    if (existsSync(canonical) && roundVerdicts.length === 0) {
      const line = readGradingVerdict(canonical)!;
      lines.push(`  latest: ${line.verdict} (${line.confidence})  [${relative(root, canonical)}]`);
    } else if (existsSync(canonical)) {
      lines.push(`  track record: ${relative(root, canonical)}`);
    }
  }
  lines.push("");

  // ── ARTIFACTS (card folder, sizes) ──
  lines.push(color("1;37", "── ARTIFACTS (card folder) ───────────────────────"));
  if (cardDir) {
    const artifacts = listArtifacts(cardDir, root);
    if (artifacts.length === 0) {
      lines.push("  (empty card folder)");
    } else {
      for (const a of artifacts) {
        lines.push(`  ${String(a.bytes).padStart(7)} B  ${a.rel}${a.note ? `  — ${a.note}` : ""}`);
      }
    }
  } else {
    lines.push("  (no card folder)");
  }
  lines.push("");
  lines.push(`╚══ ${events.length} event(s) · sources: card.md, .bandit/events/, .bandit/grading/, consult.md ═╝`);
  return lines.join("\n");
}

// ── CARD FOLDER RESOLUTION (one scan, shared) ──
// Interrupted runs can leave duplicate folders (moveCard's rename is atomic
// mid-loop, but a crash between mkdir and unlink is not). The events say
// where the card lives: the latest card.moved decides the preferred column;
// the default scan is only a fallback. Never silently prefer stale state.
const CARD_COLUMNS = ["backlog", "in-progress", "review", "done"] as const;

export function findCardDir(root: string, cardId: string): string | null {
  const moved = [...readEvents(root).filter((e) => e.card === cardId)]
    .reverse()
    .find((e) => e.type === "card.moved" && e.to !== undefined);
  const order = moved ? [String(moved.to), ...CARD_COLUMNS] : [...CARD_COLUMNS];
  const seen = new Set<string>();
  for (const col of order) {
    if (seen.has(col)) continue;
    seen.add(col);
    const candidate = join(root, ".bandit", "board", col, cardId);
    if (existsSync(join(candidate, "card.md"))) return candidate;
  }
  return null;
}

// The CLI handler uses dossierCardDir for the missing-card guard.
export function dossierCardDir(root: string, cardId: string): string | null {
  return findCardDir(root, cardId);
}