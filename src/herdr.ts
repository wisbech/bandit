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