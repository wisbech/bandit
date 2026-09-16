import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";

// migrate.ts — v2 .serf/ → v3 .bandit/.
// Cards become folders (sidecars folded inside), bandit folders pass through,
// STATE.md folds into master/state.md, flat bandit .md files fold into folders.
// Idempotent: safe to run twice; already-migrated items are skipped.

export interface MigrateReport {
  cards: number;
  sidecarsFolded: number;
  serfsPassed: number;
  flatSerfsFolded: number;
  stateFolded: boolean;
  notes: string[];
}

const COLUMNS = ["backlog", "in-progress", "review", "done"];
const SIDE_SUFFIXES = ["-plan.md", "-output.md", "-verdict.md", "-debug.md"];

export function migrate(root: string, options: { dryRun?: boolean } = {}): MigrateReport {
  const report: MigrateReport = { cards: 0, sidecarsFolded: 0, serfsPassed: 0, flatSerfsFolded: 0, stateFolded: false, notes: [] } as MigrateReport;
  const v2 = join(root, ".serf");
  const v3 = join(root, ".bandit");
  if (!existsSync(v2)) {
    report.notes.push("no .serf/ — nothing to migrate");
    return report;
  }
  if (options.dryRun) {
    report.notes.push("dry-run: no changes written");
    return countPreview(root, report);
  }

  // 1. Scaffold v3 board columns + events
  for (const col of COLUMNS) mkdirSync(join(v3, "board", col), { recursive: true });
  mkdirSync(join(v3, "events"), { recursive: true });
  mkdirSync(join(v3, "refiner"), { recursive: true });

  // 2. Cards: each non-sidecar .md becomes a folder; sidecars fold inside
  for (const col of COLUMNS) {
    const colDir = join(v2, "board", col);
    if (!existsSync(colDir)) continue;
    for (const f of readdirSync(colDir)) {
      if (!f.endsWith(".md") || SIDE_SUFFIXES.some((s) => f.endsWith(SIDE_SUFFIXES[0]) && f.endsWith(SIDE_SUFFIXES[0]))) {
        if (!f.endsWith(".md")) continue;
      }
      const base = f.replace(/(-plan|-output|-verdict|-debug)\.md$/, "").replace(/\.md$/, "");
      const isSidecar = SIDE_SUFFIXES.some((s) => f.endsWith(SIDE_SUFFIXES[0]) && f.endsWith(SIDE_SUFFIXES[0])) || SIDE_SUFFIXES.some((suf) => f.endsWith(suf));
      if (isSidecar) continue;
      const cardId = f.replace(/\.md$/, "");
      const cardDir = join(v3, "board", col, cardId);
      if (existsSync(cardDir)) continue; // idempotent: already migrated
      mkdirSync(cardDir, { recursive: true });
      const raw = readFileSync(join(colDir, f), "utf-8");
      // v2 card.md has "# title / ## Status / ..." sections; convert frontmatter
      const title = raw.match(/^# (.+)$/m)?.[1]?.trim() ?? cardId;
      writeFileSync(join(cardDir, "card.md"), `---\ncolumn: ${col}\nid: ${cardId}\ntitle: ${title}\n---\n${raw}`);
      report.cards += 1;
    }
    // fold sidecars into the card folders they belong to
    for (const f of readdirSync(colDir)) {
      const side = SIDE_SUFFIXES.find((suf) => f.endsWith(suf));
      if (!side) continue;
      const cardId = f.replace(/(-plan|-output|-verdict|-debug)\.md$/, "");
      const targetDir = join(v3, "board", col, cardId);
      if (!existsSync(targetDir)) continue;
      const kind = side.replace(".md", "").replace("-", ""); // plan|output|verdict|debug
      if (kind === "plan") {
        cpSync(join(colDir, f), join(targetDir, "plan.md"));
      } else {
        const outDir = join(targetDir, "outputs");
        mkdirSync(outDir, { recursive: true });
        cpSync(join(colDir, f), join(outDir, `${f}`));
      }
      rmSync(join(colDir, f));
      report.sidecarsFolded += 1;
    }
  }

  // 3. Serf folders: v2 folder serfs (post folder-as-state) pass through as-is
  const v2Serfs = join(v2, "serfs");
  if (existsSync(v2Serfs)) {
    for (const entry of readdirSync(v2Serfs)) {
      const src = join(v2Serfs, entry);
      const isDir = (() => {
      try { return readdirSync(src).length > 0; } catch { return false; }
    })() && !entry.endsWith(".md") && !entry.endsWith(".json");
      const hasSerfMd = existsSync(join(src, "serf.md"));
      if (!hasSerfMd && !isDir) {
        // flat .md or .subs.json — fold into a folder
        if (entry.endsWith(".md") && !entry.endsWith(".migrated.md")) {
          const name = entry.replace(/\.md$/, "");
          const target = join(v3, "serfs", name);
          mkdirSync(target, { recursive: true });
          if (!existsSync(join(target, "serf.md"))) cpSync(src, join(target, "serf.md"));
          report.flatSerfsFolded += 1;
        } else if (entry.endsWith(".subs.json")) {
          const name = entry.replace(/\.subs\.json$/, "");
          mkdirSync(join(v3, "serfs", name), { recursive: true });
          cpSync(src, join(v3, "serfs", name, "subscriptions.json"));
        }
        continue;
      }
      const name = entry;
      const target = join(v3, "serfs", name);
      if (!existsSync(target)) cpSync(src, target, { recursive: true });
      // ensure serf.md exists in the folder (folder without one gets the flat file folded)
      if (!existsSync(join(target, "serf.md"))) {
        const flatSibling = join(v2Serfs, `${entry}.md`);
        if (existsSync(flatSibling)) cpSync(flatSibling, join(target, "serf.md"));
      }
      report.serfsPassed += 1;
    }
    // ensure every bandit folder has the v3 subfolders
    for (const dir of readdirSync(join(v3, "serfs"))) {
      for (const sub of ["journal", "outputs", "memory", "children"]) {
        mkdirSync(join(v3, "serfs", dir, sub), { recursive: true });
      }
    }
  }

  // 4. Events: copy the whole history (events are the truth — never lose them)
  const v2Events = join(v2, "events");
  if (existsSync(v2Events)) {
    for (const f of readdirSync(v2Events).filter((f) => f.endsWith(".jsonl"))) {
      const target = join(v3, "events", f);
      if (!existsSync(target)) cpSync(join(v2Events, f), target);
    }
    report.notes.push("events copied (append-only history preserved)");
  }

  // 5. STATE.md → master/state.md (append)
  const statePath = join(v2, "STATE.md");
  if (existsSync(statePath)) {
    mkdirSync(join(v3, "serfs", "master"), { recursive: true });
    const masterState = join(v3, "serfs", "master", "state.md");
    const content = readFileSync(statePath, "utf-8");
    const existing = existsSync(masterState) ? readFileSync(masterState, "utf-8") : "# State\n";
    if (!existing.includes(content.slice(0, 100))) {
      writeFileSync(masterState, existing + "\n\n## Migrated from v2 STATE.md\n\n" + content);
    }
    report.stateFolded = true;
  }

  // 6. Config → v3 config (transport mapping)
  const v2Config = join(v2, "config.json");
  if (existsSync(v2Config)) {
    try {
      const old = JSON.parse(readFileSync(v2Config, "utf-8"));
      const v3Config = {
        transport: old.transport === "uhp" ? "uhp" : "headless",
        command: old.uhpBaseUrl ?? (old.terminal === "auto" ? "opencode" : old.terminal) ?? "opencode",
        args: old.uhpBaseUrl ? [old.uhpModel ?? "default", old.uhpApiKey ?? ""] : ["run"],
        container: old.verificationContainer ?? "",
        maxRetries: 3,
        refineEveryCards: 10,
        verificationContainer: old.verificationContainer ?? "",
      };
      writeFileSync(join(v3, "config.json"), JSON.stringify(v3Config, null, 2));
      report.notes.push("config.json translated (transport, container)");
    } catch {}
  }

  // 7. Mark v2 as migrated (rename, keep as archive)
  if (!existsSync(join(v2, ".migrated-to-v3"))) {
    writeFileSync(join(v2, ".migrated-to-v3"), new Date().toISOString());
  }

  return report;
}

function countPreview(root: string, report: MigrateReport): MigrateReport {
  const v2 = join(root, ".serf");
  for (const col of COLUMNS) {
    const colDir = join(v2, "board", col);
    if (!existsSync(colDir)) continue;
    for (const f of readdirSync(colDir)) {
      if (f.endsWith(".md") && !SIDE_SUFFIXES.some((suf) => f.endsWith(suf))) report.cards += 1;
      else if (SIDE_SUFFIXES.some((suf) => f.endsWith(suf))) report.sidecarsFolded += 1;
    }
  }
  return report;
}