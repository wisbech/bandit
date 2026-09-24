import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
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

// Serf roles that actually exist in this factory (have a prompt.md).
function listSerfRoles(): string[] {
  const serfsDir = join(banditDir(), "serfs");
  try {
    return readdirSync(serfsDir)
      .filter((n) => existsSync(join(serfsDir, n, "prompt.md")))
      .sort();
  } catch {
    return ["actor", "critic", "master"];
  }
}

// Harnesses actually installed on this machine (checked live), with the
// configured/last-used one first so the picker default is always valid.
function listAgents(): string[] {
  const all = ["opencode", "pi", "claude", "codex", "aider"];
  const installed: string[] = [];
  for (const a of all) {
    try {
      execSync(`command -v ${a}`, { stdio: "ignore" });
      installed.push(a);
    } catch {}
  }
  if (installed.length === 0) return ["opencode"];
  return installed;
}

// ── Per-agent launch shapes (the one place harness differences live) ──
// headless run: <args> + prompt on argv; interactive pane: <tui> <args>.
// Model is normalized to provider/id form everywhere: opencode wants
// "ollama/x", pi wants "--provider ollama --model x" but ALSO accepts
// "ollama/x", claude accepts a --model string directly.
// TUI shapes differ from headless: opencode's TUI takes NO positional arg
// (`opencode [project]` — "run" is a project path) but DOES take --model
// (serf v2's proven pane shape); claude takes --model; pi takes provider/model.
function agentLaunch(agent: string, model: string | null, mode: "headless" | "tui"): string[] {
  const modelPair = (fmt: (m: string) => string[]): string[] => (model ? fmt(model) : []);
  if (agent === "pi") {
    if (mode === "headless") return [...modelPair((m) => m.includes("/") ? ["--provider", m.split("/")[0], "--model", m.split("/")[1]] : ["--model", m]), "--no-session", "-p"];
    return modelPair((m) => m.includes("/") ? ["--provider", m.split("/")[0], "--model", m.split("/")[1]] : ["--model", m]);
  }
  if (agent === "claude") {
    if (mode === "headless") return modelPair((m) => ["--model", m.includes("/") ? m.split("/")[1] : m, "--print"]);
    return modelPair((m) => ["--model", m.includes("/") ? m.split("/")[1] : m]);
  }
  if (agent === "opencode") {
    if (mode === "headless") return modelPair((m) => ["run", "--model", m]);
    return modelPair((m) => ["--model", m]); // serf v2's proven pane shape
  }
  // codex / aider: default harness shape
  if (mode === "headless") return modelPair((m) => ["run", "--model", m]);
  return modelPair((m) => ["run", "--model", m]);
}

// Live ollama catalog (localhost:11434) — every model there works with every
// agent harness, so the picker lists them all in provider/id form.
function listOllamaModels(): string[] {
  try {
    const raw = execSync("curl -s --max-time 2 http://localhost:11434/api/tags", { encoding: "utf-8" });
    const tags = JSON.parse(raw).models as { name: string }[];
    return tags.map((m) => m.name).sort();
  } catch {
    return [];
  }
}

// ── Harness adapter profiles (.bandit/harnesses/*.json) ──
// One declarative file per harness. The factory owns identity + state; the
// harness owns its native session. ACP is the universal spoke: claude and
// codex via official adapters, anything harness-remote exposes via its
// agent-scoped routes. Bundled profiles are (re)written by init/harnesses.

const BUNDLED_HARNESSES: Record<string, { command: string; args: string[]; protocol: string; capabilities: Record<string, boolean>; note: string }> = {
  headless: { command: "opencode", args: ["run"], protocol: "headless", capabilities: {}, note: "spawn CLI with prompt on argv; gate on exit" },
  acp: { command: "npx", args: ["--yes", "@agentclientprotocol/claude-agent-acp"], protocol: "acp", capabilities: { streaming: true, cancel: true, sessions: true, models: true }, note: "official Claude Code ACP adapter (claude subscription)" },
  "acp-codex": { command: "npx", args: ["--yes", "@zed-industries/codex-acp"], protocol: "acp", capabilities: { streaming: true, cancel: true, sessions: true }, note: "Codex CLI via ACP adapter" },
  herdr: { command: "opencode", args: [], protocol: "herdr", capabilities: { streaming: false, cancel: true }, note: "visible herdr pane (primary human interface)" },
};

function ensureHarnessProfiles(): void {
  const dir = join(banditDir(), "harnesses");
  mkdirSync(dir, { recursive: true });
  for (const [name, h] of Object.entries(BUNDLED_HARNESSES)) {
    const file = join(dir, `${name}.json`);
    if (!existsSync(file)) writeFileSync(file, JSON.stringify({ name, ...h }, null, 2));
  }
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
      ensureHarnessProfiles();
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
    summary: "run the factory loop over the board (--model/--agent/--visible to override, else config; interactive picker when TTY)",
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
      let visitor = false;
      if (existsSync(lockPath)) {
        try {
          const lockPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
          process.kill(lockPid, 0); // throws if dead
          // Already running = the factory is live = open the door. You walk in
          // as a visitor; no error, no kill needed.
          visitor = true;
          console.log("  ✓ bandit is live (pid " + lockPid + ") — opening the door (panes auto-open)");
        } catch {
          console.log("  · stale lock cleared (previous run died)");
        }
      }
      if (!visitor) {
        writeFileSync(lockPath, String(process.pid));
        process.on("SIGINT", () => { try { unlinkSync(lockPath); } catch {} process.exit(0); });
      }
      const cfg = JSON.parse(readFileSync(join(banditDir(), "config.json"), "utf-8"));

      // ── Launch config: flags > interactive picker > config.json ──
      const modelFlag = args.indexOf("--model");
      const agentFlag = args.indexOf("--agent");
      const interactive = process.stdin.isTTY && modelFlag < 0 && agentFlag < 0 && !args.includes("--yes");

      if (interactive) {
        // arrow-key prompts, serf-style
        const { choose } = await import("./choose");
        const installed = listAgents();
        const agentChoices = [
          { label: `default: ${cfg.command ?? "opencode"}`, value: cfg.command ?? "opencode" },
          ...installed.filter((a) => a !== cfg.command).map((a) => ({ label: a, value: a })),
        ];
        cfg.command = await choose("Which agent?", agentChoices);
        const currentModel = extractModelArg(cfg.args ?? []);
        const ollamaModels = listOllamaModels();
        const modelChoices = [
          { label: `default: ${currentModel ?? "(agent default)"}`, value: currentModel ?? "" },
          ...ollamaModels.map((m) => ({ label: `ollama/${m}`, value: `ollama/${m}` })),
        ];
        const model = await choose("Which model? (all ollama models work with every agent)", modelChoices);
        cfg.args = agentLaunch(cfg.command, model, "headless").filter((a) => a !== "-p" && a !== "--no-session" && a !== "--print");
        // ── Visibility picker: escalation ladder — start small, open up as
        //    needed. master only (supervision), + critic (the GAN), + crew.
        const allSerfs = listSerfRoles();
        const crew = allSerfs.filter((r) => r !== "master" && r !== "critic");
        const visibility = await choose("Which serfs do you want to SEE while it runs?", [
          { label: "none — headless, watch via `bandit watch`", value: [] as string[] },
          { label: "master — supervision only", value: ["master"] as string[] },
          { label: "master + critic — the GAN, live", value: ["master", "critic"] as string[] },
          ...(crew.length ? [{ label: `master + critic + serfs — all ${allSerfs.length}`, value: allSerfs } as { label: string; value: string[] }] : []),
          ...allSerfs.filter((r) => !["master", "critic"].includes(r)).map((r) => ({ label: r, value: [r] as string[] })),
        ]);
        cfg.visibleSerfs = visibility;
        writeFileSync(join(banditDir(), "config.json"), JSON.stringify(cfg, null, 2));
        console.log(`  → saved: ${cfg.command} ${cfg.args.join(" ")} · visible: ${visibility.length ? visibility.join(" + ") : "none (headless)"}\n`);
      } else {
        if (agentFlag >= 0 && args[agentFlag + 1]) cfg.command = args[agentFlag + 1];
        if (modelFlag >= 0 && args[modelFlag + 1]) cfg.args = agentLaunch(cfg.command, args[modelFlag + 1], "headless").filter((a) => a !== "-p" && a !== "--no-session" && a !== "--print");
        const transportFlag = args.indexOf("--transport");
        if (transportFlag >= 0 && args[transportFlag + 1]) cfg.transport = args[transportFlag + 1];
        // --visible actor,critic | --visible all | --visible none
        const visibleFlag = args.indexOf("--visible");
        if (visibleFlag >= 0) {
          const raw = (args[visibleFlag + 1] ?? "").trim();
          cfg.visibleSerfs = raw === "all" ? listSerfRoles()
            : raw === "none" ? []
            : raw.split(",").map((s) => s.trim()).filter((s) => s && listSerfRoles().includes(s));
        }
        if (agentFlag >= 0 || modelFlag >= 0 || visibleFlag >= 0 || transportFlag >= 0) {
          writeFileSync(join(banditDir(), "config.json"), JSON.stringify(cfg, null, 2));
        }
      }

      // ── Panes auto-open for the serfs chosen visible (cfg.visibleSerfs) ──
      const herdr = await import("./herdr");
      // Legacy configs (no visibleSerfs) keep the old default: actor + critic.
      const wanted = (cfg.visibleSerfs !== undefined
        ? (cfg.visibleSerfs as string[]).filter((r) => listSerfRoles().includes(r))
        : ["actor", "critic"]);
      if (herdr.isHerdrRunning() && (await herdr.ping().catch(() => false)) && wanted.length > 0) {
        try {
          const workspaces = await herdr.listWorkspaces();
          const ws = workspaces.find((w) => w.label === "bandit");
          if (!ws) {
            const panesCmd = COMMANDS.find((c) => c.name === "panes")!;
            await panesCmd.fn([wanted.join(",")]);
            console.log(`  → visible serfs: ${wanted.join(" + ")} — switch to herdr to watch/steer them mid-run`);
          } else {
            const regPath = join(banditDir(), "pane-roles.json");
            const reg = existsSync(regPath) ? JSON.parse(readFileSync(regPath, "utf-8")) : {};
            const missing = [];
            for (const role of wanted) {
              const registered = reg[role];
              const alive = registered ? await herdr.isAgentAlive(registered).catch(() => false) : false;
              if (!alive) missing.push(role);
            }
            if (missing.length === 0) {
              console.log(`  ✓ panes already open (${wanted.join(" + ")} live in herdr — switch there to watch/steer)`);
            } else {
              const panesCmd = COMMANDS.find((c) => c.name === "panes")!;
              await panesCmd.fn([missing.join(",")]);
              console.log(`  → visible serfs: ${missing.join(" + ")} — switch to herdr to watch/steer them mid-run`);
            }
          }
        } catch {}
      }

      const { resolveTransport } = await import("./runner");
      const result = await runLoop({
        root: process.cwd(),
        transport: resolveTransport({ kind: cfg.transport ?? "headless", command: cfg.command ?? "opencode", args: cfg.args ?? ["run"] }, process.cwd()),
        container: cfg.container || undefined,
        maxRetries: cfg.maxRetries ?? 3,
        once: args.includes("--once"),
        readOnly: visitor, // visitors watch; the lock holder processes cards
        // Evidence-Preserving Reducer (SoL-Pi): optional cheap model that
        // compresses large gate logs into verified receipts.
        reducer: cfg.reducer ?? undefined,
      });
      if (!visitor) { try { unlinkSync(lockPath); } catch {} }
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
    name: "chat",
    summary: "walk into a serf's pane and talk — bandit chat [actor|critic|master] [--agent X]",
    fn: async (args) => {
      const herdr = await import("./herdr");
      if (!herdr.isHerdrRunning()) fail("herdr not running — start it in another terminal: `herdr`");
      if (!(await herdr.ping().catch(() => false))) fail("herdr socket not responding");
      const roleFlag = args.find((a) => !a.startsWith("--")) ?? "";
      const roles = roleFlag ? [roleFlag] : ["actor", "critic", "master"];
      const agentFlag = args.indexOf("--agent");
      const chatAgent = agentFlag >= 0 ? args[agentFlag + 1] : null;

      const workspaces = await herdr.listWorkspaces();
      const ws = workspaces.find((w) => w.label === "bandit");
      if (!ws) fail("no bandit workspace in herdr — run bandit . first");
      const panes = await herdr.listPanes(ws.workspace_id);
      const livePanes = [];
      for (const p of panes) {
        if (await herdr.isAgentAlive(p.pane_id).catch(() => false)) livePanes.push(p);
      }

      const role = roleFlag || (livePanes.length === 1 ? "actor" : null);
      if (!role) {
        // interactive pick among live panes
        console.log("\n  Live serfs:");
        for (const p of livePanes) console.log(`    ${p.pane_id}`);
        console.log(`\n  usage: bandit chat <role>   (roles: actor, critic, master)\n`);
        return;
      }

      // find the pane whose injected prompt mentioned this role (label matches)
      const regPath = join(banditDir(), "pane-roles.json");
      const reg = existsSync(regPath) ? JSON.parse(readFileSync(regPath, "utf-8")) : {};
      const registeredPaneId = reg[role];
      let target = livePanes.find((p) => p.pane_id === registeredPaneId);
      if (!target) {
        const panesCmd = COMMANDS.find((c) => c.name === "panes")!;
        await panesCmd.fn([role]);
        const refreshedPanes = await herdr.listPanes(ws.workspace_id);
        const reg2 = existsSync(regPath) ? JSON.parse(readFileSync(regPath, "utf-8")) : {};
        target = refreshedPanes.find((p) => p.pane_id === reg2[role]);
      }
      if (!target) fail(`no live pane for role '${role}' — run bandit panes ${role}`);

      console.log(`\n  ═══ BANDIT CHAT ═══════════════════════`);
      console.log(`  serf: ${role}`);
      console.log(`  pane: ${target.pane_id} (live)`);

      if (chatAgent) {
        // Human wants a DIFFERENT harness for the conversation: spawn it in a
        // side pane, seeded with the serf's folder (prompt + state + journal).
        const cfg = JSON.parse(readFileSync(join(banditDir(), "config.json"), "utf-8"));
        const model = extractModelArg(cfg.args ?? []);
        const roleDir = join(banditDir(), "serfs", role);
        const seedPrompt = `You are speaking AS the ${role} serf of this bandit factory. Adopt its identity fully.\n\nIdentity and standing prompt: .bandit/serfs/${role}/prompt.md\nState: .bandit/serfs/${role}/state.md\nJournal: .bandit/serfs/${role}/journal/\n\nRead those first, then converse with the human.`
        const tab = await herdr.createTab(ws.workspace_id, `chat-${role}`, process.cwd());
        const pane = await herdr.splitPaneInTab(tab.tab_id, "right", `chat-${role}`);
        const argPairs = agentLaunch(chatAgent, model, "tui");
        const argStr = argPairs.map((a) => JSON.stringify(a)).join(" ");
        await herdr.sendCommand(pane.pane_id, `cd ${JSON.stringify(process.cwd())} && ${chatAgent} ${argStr}`.trim());
        const chatBoot = await herdr.waitPaneAgent(pane.pane_id, 45_000);
        if (chatBoot !== "detected") {
          console.log(`  ⚠ ${chatAgent} did not boot in chat pane ${pane.pane_id} (${chatBoot})`);
          return;
        }
        await herdr.sendCommand(pane.pane_id, seedPrompt);
        console.log(`  ✓ chat with ${role} via ${chatAgent}: pane ${pane.pane_id} — switch to herdr`);
      } else {
        console.log(`  → switch to herdr, pane ${target.pane_id} — type to your ${role} directly`);
        console.log(`  · to chat via a different harness: bandit chat ${role} --agent <agent>\n`);
      }
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
      // Two tabs: management (master, critic) and workers (everything else).
      // Keeps supervision separated from the crew — and keeps panes bigger.
      // Tabs are REUSED when they already exist in the workspace: re-running
      // `bandit panes` must not spawn duplicate panes (the every-invocation
      // spawn bug, 2026-09-24 — orphan critic panes accumulated). herdr
      // labels numeric tabs as "1","2",… so match by tab_id presence per
      // group: first existing tab without a role pane becomes the reuse host.
      const management = ["master", "critic"];
      const existingTabs = await herdr.listTabs(ws.workspace_id).catch(() => []);
      const livePanes = await herdr.listPanes(ws.workspace_id).catch(() => []);
      const tabCache = new Map<string, { tab_id: string }>();
      const tabIdFor = async (role: string): Promise<string> => {
        const key = management.includes(role) ? "management" : "serfs";
        if (!tabCache.has(key)) {
          // Reuse the existing tab when the role's registered pane already
          // lives in it (registry check below handles dead panes).
          const regPath = join(banditDir(), "pane-roles.json");
          const reg = existsSync(regPath) ? JSON.parse(readFileSync(regPath, "utf-8")) : {};
          const registered = reg[key === "management" ? "master" : "actor"] as string | undefined;
          const regPane = registered ? livePanes.find((p) => p.pane_id === registered) : undefined;
          if (registered && regPane?.tab_id) {
            tabCache.set(key, { tab_id: regPane.tab_id });
            return regPane.tab_id;
          }
          const t = await herdr.createTab(ws.workspace_id, key, process.cwd());
          tabCache.set(key, t);
        }
        return tabCache.get(key)!.tab_id;
      };
      console.log(`\n  ═══ BANDIT PANES ═══════════════════════`);
      for (const role of roles) {
        const roleDir = join(banditDir(), "serfs", role);
        if (!existsSync(join(roleDir, "prompt.md"))) {
          console.log(`  · ${role}: no prompt.md — skipped`);
          continue;
        }
        const promptFile = join(roleDir, "prompt.md");
        const tab_id = await tabIdFor(role);
        const pane = await herdr.splitPaneInTab(tab_id, "right", role);
        // v2 launch pattern: JSON-quote every arg (protects spaces/specials),
        // cd wrapper, TMPDIR redirected into the project (actors must scratch
        // in cwd, never /tmp), venv discipline exported, agent launches
        // INTERACTIVE (no initial prompt on the command line), then wait for
        // boot, then inject the prompt as a typed message.
        const model = extractModelArg(cfg.args ?? []);
        const tuiArgs = agentLaunch(cfg.command ?? "opencode", model, "tui");
        const argStr = tuiArgs.map((a) => JSON.stringify(a)).join(" ");
        const tuiCommand = cfg.command ?? "opencode";
        const scratch = join(process.cwd(), ".bandit", "tmp");
        mkdirSync(scratch, { recursive: true });
        const venvPrefix = cfg.venvPrefix ?? "uv venv if missing; never install globally; use project venv/bin + local package managers (uv/bun)";
        // serf v2's proven pane launch: cd + TMPDIR redirect + command + args.
        // No wrapper, no size guard — v2 ran opencode in herdr panes for
        // months with exactly this shape. When a crash appears, match v2
        // before inventing mechanism (the handshake wrapper was reverted).
        const launch = `cd ${JSON.stringify(process.cwd())} && mkdir -p .bandit/tmp && export TMPDIR=${JSON.stringify(scratch)} && ${tuiCommand} ${argStr}`.trim();
        // Event-driven boot: subscribe BEFORE launching, then wait for
        // pane.agent_detected / pane.exited from the herdr event stream.
        // No sleeps, no alive-polls — the push replaces the poll.
        let booted: "detected" | "exited" | "timeout" = "timeout";
        for (let attempt = 1; attempt <= 2; attempt++) {
          const waitP = herdr.waitPaneAgent(pane.pane_id, 45_000);
          await herdr.sendCommand(pane.pane_id, launch);
          booted = await waitP;
          if (booted === "detected") break;
          if (booted === "timeout") {
            // event stream may have missed a fast boot — one liveness check
            const alive = await herdr.isAgentAlive(pane.pane_id).catch(() => false);
            if (alive) { booted = "detected"; break; }
          }
          if (attempt === 1) console.log(`  · ${role}: boot attempt 1 failed in ${pane.pane_id} (${booted}) — retrying`);
        }
        if (booted !== "detected") {
          console.log(`  ⚠ ${role}: agent did not boot in pane ${pane.pane_id} — skipping injection (check pane in herdr)`);
          continue;
        }
        // Inject after boot; confirm the TUI took the prompt with a short
        // event wait — a status transition (idle→working) means it accepted.
        await herdr.sendCommand(pane.pane_id, `Read ${promptFile} and adopt that role fully. You are the ${role} bandit of this factory. ENVIRONMENT DISCIPLINE: every file you create — scripts, probes, downloads, scratch, data — goes under the project directory (cwd or .bandit/tmp). NEVER write to /tmp or anywhere outside the project. Use the project's virtual environment (uv/bun); never install globally. ${role === "critic" ? "Wait for the harness to show you work to evaluate." : "Wait for the harness to hand you cards."}`);
        const afterEvent = await Promise.race([
          herdr.nextPaneEvent(pane.pane_id, 4_000),
          new Promise((r) => setTimeout(() => r(null), 4_000)),
        ]) as { type: string; agent_status?: string } | null;
        const aliveAfter = afterEvent?.type === "pane.exited" ? false : await herdr.isAgentAlive(pane.pane_id).catch(() => false);
        // role->pane registry (herdr's pane.list doesn't return labels)
        const regPath = join(banditDir(), "pane-roles.json");
        const reg = existsSync(regPath) ? JSON.parse(readFileSync(regPath, "utf-8")) : {};
        reg[role] = aliveAfter ? pane.pane_id : reg[role];
        writeFileSync(regPath, JSON.stringify(reg, null, 2));
        console.log(`  ✓ ${role}: pane ${pane.pane_id} launched + prompt injected (alive: ${aliveAfter})`);
      }
      console.log(`  → workspace: bandit / tabs: management (master, critic) + serfs — switch to herdr to watch and steer\n`);
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
        const { runTransport, resolveTransport } = await import("./runner");
        const run = await runTransport(
          resolveTransport({ kind: cfg.transport ?? "headless", command: cfg.command ?? "opencode", args: cfg.args ?? ["run"] }, process.cwd()),
          prompt, process.cwd(), join(banditDir(), "refiner-last-llm.md"), cfg.timeoutMs ?? 120_000,
        );
        return run.output;
      }, { force: args.includes("--force") });
      console.log(`  ${result.ran ? `applied ${result.applied.length}, skipped ${result.skipped.length}` : `not run: ${result.reason}`}`);
      for (const e of result.applied) console.log(`   ✓ [${e.serf}] ${e.op} ${e.target}${e.name ? ` ${e.name}` : ""} — ${e.reason}`);
    },
  },
  {
    name: "harnesses",
    summary: "list harness adapter profiles (.bandit/harnesses/) — or add: bandit harnesses add <name> <command> [args...] [--protocol acp|headless]",
    fn: async (args) => {
      if (args[0] === "add") {
        ensureHarnessProfiles();
        const name = args[1];
        if (!name) fail("usage: bandit harnesses add <name> <command> [args...] [--protocol acp|headless]");
        const protoFlag = args.indexOf("--protocol");
        const protocol = protoFlag >= 0 ? args[protoFlag + 1] ?? "acp" : "acp";
        const rest = args.slice(2).filter((a, i) => a !== "--protocol" && args[protoFlag >= 0 ? protoFlag + 1 : -1] !== a || i === 0);
        const command = rest[0];
        const pargs = rest.slice(1).filter((a) => a !== "--protocol");
        if (!command) fail("missing command — usage: bandit harnesses add <name> <command> [args...]");
        const file = join(banditDir(), "harnesses", `${name}.json`);
        writeFileSync(file, JSON.stringify({ name, command, args: pargs, protocol, capabilities: { streaming: protocol === "acp", cancel: protocol === "acp", sessions: protocol === "acp" } }, null, 2));
        console.log(`  ✓ harness profile: ${file}`);
        console.log(`  → use it: set "transport": "${name}" in .bandit/config.json (or bandit start --transport ${name})\n`);
        return;
      }
      ensureHarnessProfiles();
      const { loadHarnessProfiles } = await import("./runner");
      const cfg = JSON.parse(readFileSync(join(banditDir(), "config.json"), "utf-8"));
      const current = cfg.transport ?? "headless";
      console.log(`\n  ═══ BANDIT HARNESSES ═══════════════════════`);
      const profiles = loadHarnessProfiles(process.cwd());
      for (const [name, p] of profiles) {
        const marker = name === current ? " ● active" : "";
        console.log(`  ${name.padEnd(12)} ${p.protocol.padEnd(9)} ${p.command} ${(p.args ?? []).join(" ")}${marker}`);
      }
      console.log(`\n  → switch: "transport": "<name>" in .bandit/config.json, or bandit start --transport <name>`);
      console.log(`  → add:    bandit harnesses add <name> <command> [args...] [--protocol acp]\n`);
    },
  },
  {
    name: "decisions",
    summary: "decision-evaluator health — reachability, question stats (adapter-agnostic)",
    fn: async () => {
      if (!existsSync(banditDir())) fail("no .bandit/");
      const { loadDecisionConfig, resolveDecisionPort } = await import("./decisions");
      const cfg = loadDecisionConfig(process.cwd());
      console.log(`\n  ═══ DECISION EVALUATOR ═══════════════════════`);
      if (!cfg) {
        console.log(`  · none configured — add to .bandit/config.json:`);
        console.log(`      "decisions": { "evaluator": "systemone", "endpoint": "http://127.0.0.1:8770" }`);
        console.log(`  · evaluator "systemone" speaks the SystemOne wire protocol — served by`);
        console.log(`        laya-serve (local, Apache-2.0) OR TypeSafe's hosted Jev, same wire`);
        console.log(`  → run locally: pip install "laya[serve]" && laya-serve`);
        console.log(`  → with no evaluator, all decision questions fail closed;`);
        console.log(`        factory behavior is unchanged\n`);
        return;
      }
      console.log(`  evaluator: ${cfg.evaluator} · endpoint: ${cfg.endpoint}${cfg.model ? ` · model: ${cfg.model}` : ""}`);
      const t0 = Date.now();
      const port = resolveDecisionPort(cfg);
      const demo = await port.demonstrates("The file must contain HELLO_WORLD", "HELLO_WORLD");
      const ms = Date.now() - t0;
      if (demo !== null) {
        console.log(`  ✓ ${cfg.evaluator} reachable — answered in ${ms}ms`);
      } else {
        console.log(`  ✗ no answer in ${ms}ms — fail-closed (factory runs unchanged)`);
      }
      // event stats from the log
      const { readEvents } = await import("./loop");
      const events = readEvents();
      const gate = events.filter((e) => e.type === "decisions.gate");
      const vacuous = events.filter((e) => e.type === "decisions.vacuous");
      const lowDemo = events.filter((e) => e.type === "decisions.low_demonstrability");
      const sim = events.filter((e) => e.type === "decisions.failure_similarity");
      console.log(`  events: ${gate.length} gate checks · ${vacuous.length} vacuous · ${lowDemo.length} low-demonstrability · ${sim.length} similarity`);
      if (gate.length > 0) {
        const withDemo = gate.filter((e) => typeof e.demonstrates === "number");
        if (withDemo.length > 0) {
          const avg = withDemo.reduce((s, e) => s + Number(e.demonstrates), 0) / withDemo.length;
          console.log(`  demonstrability: mean ${avg.toFixed(2)} over ${withDemo.length} gate checks`);
        }
      }
      console.log();
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
