import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { runLoop, cardsIn } from "./loop";

// cli.ts — command table (~30 lines). No switch-casing.

const VERSION = "0.1.0";

type Handler = (args: string[]) => Promise<void> | void;

interface Command {
  name: string;
  summary: string;
  fn: Handler;
}

function banditDir(): string {
  return join(process.cwd(), ".bandit");
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const COMMANDS: Command[] = [
  {
    name: "init",
    summary: "scaffold .bandit/ in the current project",
    fn: () => {
      if (existsSync(banditDir())) return fail(".bandit/ already exists");
      mkdirSync(banditDir(), { recursive: true });
      for (const c of ["backlog", "in-progress", "review", "done"]) {
        mkdirSync(join(banditDir(), "board", c), { recursive: true });
      }
      mkdirSync(join(banditDir(), "events"), { recursive: true });
      const config = { transport: "headless", command: "opencode", args: ["run"], container: "", maxRetries: 3, refineEveryCards: 10 };
      writeFileSync(join(banditDir(), "config.json"), JSON.stringify(config, null, 2));
      writeFileSync(join(banditDir(), "plan.md"), "# Plan\n\nThe mission and current direction.\n");
      for (const name of ["master", "critic", "actor"]) {
        mkdirSync(join(banditDir(), "serfs", name, "journal"), { recursive: true });
        mkdirSync(join(banditDir(), "serfs", name, "outputs"), { recursive: true });
        mkdirSync(join(banditDir(), "serfs", name, "memory"), { recursive: true });
        mkdirSync(join(banditDir(), "serfs", name, "children"), { recursive: true });
        const identity = `# ${name}\n\n## Mission\n${name === "master" ? "Coordinate the factory. The buck stops here." : name === "critic" ? "Adversarially evaluate work. Every verdict cites evidence." : "Execute tasks. Edit real source files. Verify or fix."}\n\n## Persona\nDirect.\n\n## Fate\nIf I fail 3 times, the task is bad, not me.\n`;
        writeFileSync(join(banditDir(), "serfs", name, "serf.md"), identity);
        writeFileSync(join(banditDir(), "serfs", name, "origin.md"), `spawned_by: init\ncard: \ncreated: ${new Date().toISOString()}\n`);
        writeFileSync(join(banditDir(), "serfs", name, "state.md"), "# State\n\n");
        writeFileSync(join(banditDir(), "serfs", name, "prompt.md"), `You are ${name}. ${name === "actor" ? "Execute the task. Edit real source files.\n\nTASK: {{card.task}}\n\nACCEPTANCE:\n{{card.acceptance}}\n\nReport VERIFICATION_COMMAND, VERIFICATION_EXIT_CODE, VERIFICATION_OUTPUT." : name === "critic" ? "Evaluate adversarially. Demand evidence for every criterion." : "Coordinate the factory."}\n`);
      }
      console.log("  .bandit/ created. A bandit is a folder. A card is a folder.");
    },
  },
  {
    name: "task",
    summary: 'add a card: bandit task "title" --accept "c1" --accept "c2"',
    fn: async (args) => {
      if (!existsSync(banditDir())) fail("no .bandit/ — run bandit init");
      const title = args[0];
      if (!title) fail('usage: bandit task "title" [--accept "criterion"]');
      const accepts = args.flatMap((a, i) => (a === "--accept" ? [args[i + 1]] : [])).filter(Boolean);
      const id = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now().toString(36)}`;
      const cardDir = join(banditDir(), "board", "backlog", id);
      mkdirSync(cardDir, { recursive: true });
      writeFileSync(join(cardDir, "card.md"), `---\ncolumn: backlog\nid: ${id}\ntitle: ${title}\n---\n# ${title}\n\n## Acceptance\n${accepts.map((a) => `- ${a}`).join("\n") || "- verification command passes"}\n`);
      const { emit } = await import("./loop");
      emit("card.created", { card: id, title });
      console.log(`  card: ${id}`);
    },
  },
  {
    name: "board",
    summary: "show the kanban",
    fn: () => {
      if (!existsSync(banditDir())) fail("no .bandit/");
      for (const col of ["backlog", "in-progress", "review", "done"]) {
        const cards = cardsIn(col as never);
        console.log(`\n${col} (${cards.length}):`);
        for (const c of cards) console.log(`  ${c.id} — ${c.frontmatter.title ?? ""}`);
      }
      console.log();
    },
  },
  {
    name: "start",
    summary: "run the factory loop over the board (--model/--agent to override, else config; interactive picker when TTY)",
    fn: async (args) => {
      if (!existsSync(banditDir())) fail("no .bandit/ — run bandit init");
      // Guard: v2 bandit running in this project? Two factories on one board = chaos.
      const v2PidPath = join(process.cwd(), ".serf", "tmp", "main.pid");
      if (existsSync(v2PidPath)) {
        try {
          const v2Pid = parseInt(readFileSync(v2PidPath, "utf-8").trim(), 10);
          process.kill(v2Pid, 0);
          fail(`v2 bandit still running (pid ${v2Pid}). Stop it first: kill ${v2Pid} (or 'bandit recover' in v2). One factory per project.`);
        } catch {
          // dead v2 pid — stale marker, ignore
        }
      }
      // Single-runner lock (the suspended-pid fix): a stale lock from a dead
      // process is auto-cleared; a live one refuses with its pid.
      const lockPath = join(banditDir(), "run.lock");
      if (existsSync(lockPath)) {
        try {
          const lockPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
          process.kill(lockPid, 0); // throws if dead
          fail(`bandit is already holding the board (pid ${lockPid}) — it is watching, not stuck. To run a fresh pass: kill ${lockPid} && bandit .`);
        } catch {
          console.log("  · stale lock cleared (previous run died)");
        }
      }
      writeFileSync(lockPath, String(process.pid));
      process.on("SIGINT", () => { try { unlinkSync(lockPath); } catch {} process.exit(0); });
      const cfg = JSON.parse(readFileSync(join(banditDir(), "config.json"), "utf-8"));

      // ── Launch config: flags > interactive picker > config.json ──
      const modelFlag = args.indexOf("--model");
      const agentFlag = args.indexOf("--agent");
      const interactive = process.stdin.isTTY && modelFlag < 0 && agentFlag < 0 && !args.includes("--yes");

      if (interactive) {
        // arrow-key prompts, serf-style
        const { choose } = await import("./choose");
        const agents = ["opencode", "claude", "codex", "pi", "aider"].filter((a) => a === cfg.command || !cfg.command || a !== cfg.command);
        const currentModel = extractModelArg(cfg.args ?? []);
        cfg.command = await choose("Which agent?", [
          { label: `default: ${cfg.command ?? "opencode"}`, value: cfg.command ?? "opencode" },
          ...agents.map((a) => ({ label: a, value: a })),
        ]);
        const model = await choose("Which model?", [
          { label: `default: ${currentModel ?? "(agent default)"}`, value: currentModel ?? "" },
          { label: "glm-5.3-flash:cloud (ollama cloud)", value: "ollama/glm-5.3-flash:cloud" },
          { label: "qwen3.5 (local ollama)", value: "ollama/qwen3.5" },
        ]);
        cfg.args = model ? ["run", "--model", model] : ["run"];
        writeFileSync(join(banditDir(), "config.json"), JSON.stringify(cfg, null, 2));
        console.log(`  → saved: ${cfg.command} ${cfg.args.join(" ")}\n`);
      } else {
        if (agentFlag >= 0 && args[agentFlag + 1]) cfg.command = args[agentFlag + 1];
        if (modelFlag >= 0 && args[modelFlag + 1]) cfg.args = ["run", "--model", args[modelFlag + 1]];
        if (agentFlag >= 0 || modelFlag >= 0) {
          writeFileSync(join(banditDir(), "config.json"), JSON.stringify(cfg, null, 2));
        }
      }

      // ── Panes auto-open when herdr is up: serfs are visible+steerable by default ──
      const herdr = await import("./herdr");
      if (herdr.isHerdrRunning() && (await herdr.ping().catch(() => false))) {
        try {
          const workspaces = await herdr.listWorkspaces();
          const ws = workspaces.find((w) => w.label === "bandit");
          const allPanes = ws ? await herdr.listPanes(ws.workspace_id) : [];
          const existingPanes = [];
          for (const p of allPanes) {
            if (await herdr.isAgentAlive(p.pane_id).catch(() => false)) existingPanes.push(p);
          }
          if (ws && existingPanes.length > 0) {
            console.log(`  ✓ panes already open (${existingPanes.length} live serfs in herdr — switch there to watch/steer)`);
          } else {
            const panesCmd = COMMANDS.find((c) => c.name === "panes")!;
            await panesCmd.fn(["actor,critic"]);
            console.log("  → serfs visible in herdr — switch there to watch/steer them mid-run");
          }
        } catch {}
      }

      const result = await runLoop({
        root: process.cwd(),
        transport: { kind: cfg.transport ?? "headless", command: cfg.command ?? "opencode", args: cfg.args ?? ["run"] },
        container: cfg.container || undefined,
        maxRetries: cfg.maxRetries ?? 3,
        once: args.includes("--once"),
      });
      console.log(`\n  processed: ${result.processed} | done: ${result.completed} | failed: ${result.failed}\n`);
      try { unlinkSync(lockPath); } catch {}
    },
  },
  {
    name: "events",
    summary: "show the event log (the truth)",
    fn: async () => {
      const { readEvents } = await import("./loop");
      const events = readEvents();
      for (const e of events.slice(-30)) console.log(`  ${e.ts} ${e.type} ${JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !["type", "ts"].includes(k)))).slice(0, 120)}`);
      if (events.length === 0) console.log("  (no events)");
    },
  },
  {
    name: "panes",
    summary: "open herdr panes per bandit (visible+steerable) — or manage them: bandit panes --stop [idle|all|pane_id]",
    fn: async (args) => {
      const herdr = await import("./herdr");
      // ── Lifecycle management (thermal discipline): bandit panes --stop ──
      if (args.includes("--stop")) {
        if (!herdr.isHerdrRunning()) fail("herdr not running");
        const what = args[args.indexOf("--stop") + 1] ?? "idle";
        const panes = await herdr.listPanes();
        let stopped = 0;
        for (const p of panes) {
          const alive = await herdr.isAgentAlive(p.pane_id).catch(() => false);
          if (!alive) continue;
          const shouldStop = what === "all" ? true : what === p.pane_id ? true : (p.agent_status === "blocked" || p.agent_status === "idle");
          if (!shouldStop) continue;
          // graceful: ctrl-c then exit, then hard kill the foreground process
          await herdr.send("pane.send_keys", { pane_id: p.pane_id, keys: ["ctrl+c"] });
          await new Promise((r) => setTimeout(r, 800));
          await herdr.sendCommand(p.pane_id, "exit");
          await new Promise((r) => setTimeout(r, 1200));
          const stillAlive = await herdr.isAgentAlive(p.pane_id).catch(() => false);
          if (stillAlive) {
            try {
              const info = await herdr.send("pane.process_info", { pane_id: p.pane_id }, 5000);
              for (const proc of info?.process_info?.foreground_processes ?? []) {
                if (!["zsh", "bash", "sh", "fish"].includes((proc.name || "").toLowerCase())) {
                  process.kill(proc.pid, "SIGTERM");
                }
              }
            } catch {}
          }
          stopped += 1;
          console.log(`  ■ stopped ${p.pane_id} (${p.agent_status ?? "?"})`);
        }
        console.log(`  → ${stopped} agent(s) stopped. Idle/blocked panes no longer burn CPU.\n`);
        return;
      }
      if (!existsSync(banditDir())) fail("no .bandit/");
      if (!herdr.isHerdrRunning()) {
        fail("herdr not running — start it in another terminal first: `herdr`");
      }
      if (!(await herdr.ping())) fail("herdr socket not responding");
      const cfg = JSON.parse(readFileSync(join(banditDir(), "config.json"), "utf-8"));
      const roles = (args[0] ? args[0].split(",") : ["actor", "critic", "master"]);
      // reuse or create the "bandit" workspace
      const workspaces = await herdr.listWorkspaces();
      let ws = workspaces.find((w) => w.label === "bandit");
      if (!ws) {
        const created = await herdr.createWorkspace("bandit", process.cwd());
        ws = { workspace_id: created.workspace_id, label: "bandit" };
      }
      const tab = await herdr.createTab(ws.workspace_id, "serfs", process.cwd());
      console.log(`\n  ═══ BANDIT PANES ═══════════════════════`);
      for (const role of roles) {
        const roleDir = join(banditDir(), "serfs", role);
        if (!existsSync(join(roleDir, "prompt.md"))) {
          console.log(`  · ${role}: no prompt.md — skipped`);
          continue;
        }
        const promptFile = join(roleDir, "prompt.md");
        const pane = await herdr.splitPaneInTab(tab.tab_id, "right", role);
        // v2 launch pattern: JSON-quote every arg (protects spaces/specials),
        // cd wrapper, TMPDIR redirected into the project (actors must scratch
        // in cwd, never /tmp), venv discipline exported, agent launches
        // INTERACTIVE (no initial prompt on the command line), then wait for
        // boot, then inject the prompt as a typed message.
        const model = extractModelArg(cfg.args ?? []);
        const argPairs = model ? ["--model", model] : [];
        const argStr = argPairs.map((a) => JSON.stringify(a)).join(" ");
        const tuiCommand = cfg.command === "opencode" ? "opencode" : cfg.command;
        const scratch = join(process.cwd(), ".bandit", "tmp");
        mkdirSync(scratch, { recursive: true });
        const venvPrefix = cfg.venvPrefix ?? "uv venv if missing; never install globally; use project venv/bin + local package managers (uv/bun)";
        const launch = `cd ${JSON.stringify(process.cwd())} && mkdir -p .bandit/tmp && export TMPDIR=${JSON.stringify(scratch)} && echo "${venvPrefix}" > /dev/null && ${tuiCommand} ${argStr}`.trim();
        await herdr.sendCommand(pane.pane_id, launch);
        // v2 waited 10s for the TUI to boot before typing anything.
        await new Promise((r) => setTimeout(r, 10_000));
        // Gate: only inject if the agent TUI is actually alive.
        const alive = await herdr.isAgentAlive(pane.pane_id).catch(() => false);
        if (!alive) {
          console.log(`  ⚠ ${role}: agent did not boot in pane ${pane.pane_id} — skipping injection (check pane in herdr)`);
          continue;
        }
        await herdr.sendCommand(pane.pane_id, `Read ${promptFile} and adopt that role fully. You are the ${role} bandit of this factory. ENVIRONMENT DISCIPLINE: every file you create — scripts, probes, downloads, scratch, data — goes under the project directory (cwd or .bandit/tmp). NEVER write to /tmp or anywhere outside the project. Use the project's virtual environment (uv/bun); never install globally. ${role === "critic" ? "Wait for the harness to show you work to evaluate." : "Wait for the harness to hand you cards."}`);
        const aliveAfter = await herdr.isAgentAlive(pane.pane_id).catch(() => false);
        console.log(`  ✓ ${role}: pane ${pane.pane_id} launched + prompt injected (alive: ${aliveAfter})`);
      }
      console.log(`  → workspace: bandit / tab: serfs — switch to herdr to watch and steer\n`);
    },
  },
  {
    name: "watch",
    summary: "live dashboard — see agents working (Ctrl+C to exit)",
    fn: async () => {
      if (!existsSync(banditDir())) fail("no .bandit/");
      const { watchLoop } = await import("./watch");
      const stop = watchLoop(2000);
      process.on("SIGINT", () => { stop(); process.exit(0); });
      await new Promise(() => {});
    },
  },
  {
    name: "confidence",
    summary: "show the confidence ledger (per-claim corroboration depth)",
    fn: async () => {
      if (!existsSync(banditDir())) fail("no .bandit/");
      const { renderConfidence } = await import("./confidence");
      console.log("\n" + renderConfidence(process.cwd()) + "\n");
    },
  },
  {
    name: "bandit",
    summary: "show the bandit governor (readiness + posteriors)",
    fn: async () => {
      if (!existsSync(banditDir())) fail("no .bandit/");
      const { renderBandit } = await import("./bandit");
      console.log("\n" + renderBandit(process.cwd()) + "\n");
    },
  },
  {
    name: "migrate",
    summary: "fold a v2 .serf/ into .bandit/ (--dry-run to preview)",
    fn: async (args) => {
      const { migrate } = await import("./migrate");
      const report = migrate(process.cwd(), { dryRun: args.includes("--dry-run") });
      console.log(`\n  ═══ BANDIT MIGRATE ═══════════════════════`);
      console.log(`  cards → folders: ${report.cards}`);
      console.log(`  sidecars folded: ${report.sidecarsFolded}`);
      console.log(`  bandit folders passed through: ${report.serfsPassed}`);
      console.log(`  flat serfs folded: ${report.flatSerfsFolded}`);
      console.log(`  STATE.md folded: ${report.stateFolded ? "yes" : "no"}`);
      for (const n of report.notes) console.log(`  · ${n}`);
      console.log();
    },
  },
  {
    name: "refine",
    summary: "run a refiner pass (--force, --rollback <ts>, --history)",
    fn: async (args) => {
      if (!existsSync(banditDir())) fail("no .bandit/");
      const { runRefinePass, rollbackTo, readHistory } = await import("./refiner");
      const rollbackFlag = args.indexOf("--rollback");
      if (rollbackFlag >= 0) {
        const ts = args[rollbackFlag + 1];
        if (!ts) fail("usage: bandit refine --rollback <snapshot-ts>");
        console.log(rollbackTo(process.cwd(), ts) ? `  ✓ rolled back to ${ts}` : `  ⚠ snapshot ${ts} not found`);
        return;
      }
      if (args.includes("--history")) {
        const history = readHistory(process.cwd(), 15);
        if (history.length === 0) { console.log("  (no history)"); return; }
        for (const h of history) console.log(`  ${h.ts} ${h.action} edits=${(h.edits as unknown[])?.length ?? 0}`);
        return;
      }
      const cfg = JSON.parse(readFileSync(join(banditDir(), "config.json"), "utf-8"));
      const result = await runRefinePass(process.cwd(), async (prompt) => {
        const { runTransport } = await import("./runner");
        const run = await runTransport(
          { kind: cfg.transport ?? "headless", command: cfg.command ?? "opencode", args: cfg.args ?? ["run"] },
          prompt, process.cwd(), join(banditDir(), "refiner-last-llm.md"), 120_000,
        );
        return run.output;
      }, { force: args.includes("--force") });
      console.log(`  ${result.ran ? `applied ${result.applied.length}, skipped ${result.skipped.length}` : `not run: ${result.reason}`}`);
      for (const e of result.applied) console.log(`   ✓ [${e.serf}] ${e.op} ${e.target}${e.name ? ` ${e.name}` : ""} — ${e.reason}`);
    },
  },
  {
    name: "help",
    summary: "this message",
    fn: () => {
      console.log(`\nbandit ${VERSION} — the folder factory\n`);
      for (const c of COMMANDS) console.log(`  bandit ${c.name.padEnd(10)} ${c.summary}`);
      console.log();
    },
  },
];

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "--help" || cmd === "-h") { await COMMANDS.find((c) => c.name === "help")!.fn([]); return; }
  const command = COMMANDS.find((c) => c.name === cmd);
  if (!command) {
    // `bandit .` = init (if needed) + start
    if (cmd === ".") {
      if (!existsSync(banditDir())) await COMMANDS[0].fn([]);
      await COMMANDS.find((c) => c.name === "start")!.fn(args);
      return;
    }
    fail(`unknown command: ${cmd ?? "(none)"} — try bandit help`);
  }
  await command.fn(args);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
function extractModelArg(args: string[]): string | null {
  const i = args.indexOf("--model");
  return i >= 0 ? args[i + 1] : null;
}
