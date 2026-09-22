import { connect } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// herdr.ts — thin socket client for the herdr pane daemon (v2's herdr-client,
// ported lean). Panes are bandit's primary human interface: you SEE the actor
// and critic working and can type to them mid-run.

const DEFAULT_SOCKET = join(homedir(), ".config", "herdr", "herdr.sock");

export function getSocketPath(): string {
  return process.env.HERDR_SOCKET_PATH || DEFAULT_SOCKET;
}

export function isHerdrRunning(): boolean {
  return existsSync(getSocketPath());
}

let requestId = 0;

export function send(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<any> {
  const socketPath = getSocketPath();
  if (!existsSync(socketPath)) throw new Error(`herdr socket not found at ${socketPath}. Is herdr running?`);
  const id = `bandit-${++requestId}`;
  const message = JSON.stringify({ id, method, params }) + "\n";
  const timeout = timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`herdr ${method} timed out`)); }, timeout);
    socket.on("connect", () => socket.write(message));
    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          if (response.id !== id) continue;
          clearTimeout(timer);
          socket.destroy();
          if (response.error) reject(new Error(response.error.message || "herdr error"));
          else resolve(response.result ?? response);
        } catch {}
      }
    });
    socket.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

export async function ping(): Promise<boolean> {
  try { await send("ping", {}, 2000); return true; } catch { return false; }
}

export interface PaneInfo {
  pane_id: string;
  workspace_id?: string;
  tab_id?: string;
  label?: string;
  display_agent?: string;
  agent_status?: string;
  agent?: string;
  cwd?: string;
}

export async function listPanes(workspaceId?: string): Promise<PaneInfo[]> {
  const params: Record<string, unknown> = workspaceId ? { workspace_id: workspaceId } : {};
  const result = await send("pane.list", params);
  return result?.panes ?? result?.data ?? [];
}

export async function listWorkspaces(): Promise<{ workspace_id: string; label: string; cwd?: string }[]> {
  const result = await send("workspace.list");
  return result?.workspaces ?? result?.data ?? [];
}

export async function createWorkspace(label: string, cwd?: string): Promise<{ workspace_id: string }> {
  const result = await send("workspace.create", { label, cwd: cwd ?? process.cwd() });
  return result?.workspace ?? result;
}

export async function createTab(workspaceId: string, label?: string, cwd?: string): Promise<{ tab_id: string; workspace_id: string }> {
  const result = await send("tab.create", { workspace_id: workspaceId, label, cwd: cwd ?? process.cwd() });
  return result?.tab ?? result;
}

export async function splitPaneInTab(tabId: string, direction: "right" | "down" = "right", label?: string): Promise<{ pane_id: string }> {
  const result = await send("pane.split", { tab_id: tabId, direction });
  const pane = result?.pane ?? result;
  if (label && pane?.pane_id) await labelPane(pane.pane_id, label).catch(() => {});
  return pane;
}

export async function labelPane(paneId: string, text: string): Promise<void> {
  await send("pane.report_metadata", { pane_id: paneId, source: "bandit", display_agent: text }).catch(() => {});
}

// Type a command into the pane and press enter (this is how prompts are
// injected and how the human's shell receives the agent launch line).
export async function sendCommand(paneId: string, command: string): Promise<void> {
  await send("pane.send_text", { pane_id: paneId, text: command });
  await send("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
}

export async function paneStatus(paneId: string): Promise<string> {
  try {
    const result = await send("pane.list", {});
    const panes = result?.panes ?? result?.data ?? [];
    const pane = panes.find((p: any) => p.pane_id === paneId);
    return pane?.agent_status || "unknown";
  } catch {
    return "unknown";
  }
}

export async function isAgentAlive(paneId: string): Promise<boolean> {
  try {
    const procInfo = await send("pane.process_info", { pane_id: paneId }, 5000);
    const procs = procInfo?.process_info?.foreground_processes ?? [];
    return procs.some((p: any) => {
      const name = (p.name || "").toLowerCase();
      return name !== "zsh" && name !== "bash" && name !== "sh" && name !== "fish";
    });
  } catch {
    return false;
  }
}

// ── PANE EVENTS (push, not poll) ──
// herdr pushes pane lifecycle events over the same socket:
//   pane.agent_detected  — an agent TUI booted in the pane
//   pane.agent_status_changed — working/idle transitions (turn done)
//   pane.exited          — the pane's process died
// The 10s boot sleeps and alive-polls in the panes command are replaced by
// this stream. fs.watch wakes the loop; events resolve the panes.

export interface PaneEvent {
  type: string;
  pane_id?: string;
  agent?: string;
  agent_status?: string;
  [k: string]: unknown;
}

const VALID_PANE_EVENT_TYPES = ["pane.agent_detected", "pane.agent_status_changed", "pane.exited"] as const;

// One shared subscription per process: subscribe once, fan out to listeners.
interface PaneEventBus {
  listeners: ((e: PaneEvent) => void)[];
  socket: import("node:net").Socket | null;
  buffer: string;
}

const bus: PaneEventBus = { listeners: [], socket: null, buffer: "" };

const VALID_TYPES = new Set<string>(VALID_PANE_EVENT_TYPES);
const watchedPanes = new Set<string>();

function busSend(msg: Record<string, unknown>): void {
  if (bus.socket && bus.socket.writable) bus.socket.write(JSON.stringify(msg) + "\n");
}

function ensureBus(): import("node:net").Socket {
  if (bus.socket) return bus.socket;
  const socket = connect(getSocketPath());
  bus.socket = socket;
  socket.on("connect", () => {
    // (re)subscribe on connect with the union of watched panes
    const panes = [...watchedPanes];
    if (panes.length === 0) return;
    busSend({
      id: `bandit-bus-${++requestId}`,
      method: "events.subscribe",
      params: { subscriptions: panes.flatMap((pane_id) => [...VALID_TYPES].map((type) => ({ type, pane_id }))) },
    });
  });
  socket.on("data", (chunk) => {
    bus.buffer += chunk.toString();
    let nl: number;
    while ((nl = bus.buffer.indexOf("\n")) >= 0) {
      const line = bus.buffer.slice(0, nl).trim();
      bus.buffer = bus.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.method === "event" && msg.params) {
          for (const l of [...bus.listeners]) l(msg.params as PaneEvent);
        }
      } catch {}
    }
  });
  socket.on("error", () => { bus.socket = null; });
  socket.on("close", () => { bus.socket = null; });
  return socket;
}

function busSubscribe(paneId: string): void {
  watchedPanes.add(paneId);
  ensureBus();
  busSend({
    id: `bandit-sub-${++requestId}`,
    method: "events.subscribe",
    params: { subscriptions: [...VALID_TYPES].map((type) => ({ type, pane_id: paneId })) },
  });
}

// Resolve on the FIRST matching event for a pane. No polling.
export function nextPaneEvent(paneId: string, timeoutMs = 30_000): Promise<PaneEvent | null> {
  busSubscribe(paneId);
  return new Promise((resolve) => {
    const listener = (e: PaneEvent) => {
      if (e.pane_id !== paneId) return;
      bus.listeners.splice(bus.listeners.indexOf(listener), 1);
      clearTimeout(timer);
      resolve(e);
    };
    const timer = setTimeout(() => {
      const i = bus.listeners.indexOf(listener);
      if (i >= 0) bus.listeners.splice(i, 1);
      resolve(null);
    }, timeoutMs);
    bus.listeners.push(listener);
  });
}

// Wait (event-driven) for an agent to boot in the pane — or report death.
export async function waitPaneAgent(paneId: string, timeoutMs = 30_000): Promise<"detected" | "exited" | "timeout"> {
  const e = await nextPaneEvent(paneId, timeoutMs);
  if (!e) return "timeout";
  if (e.type === "pane.agent_detected") return "detected";
  if (e.type === "pane.exited") return "exited";
  return "timeout";
}