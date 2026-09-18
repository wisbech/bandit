# Harnesses

> The factory owns identity and state; the harness owns its native session. Never invent a control the harness didn't advertise.

A harness is any coding-agent runtime — opencode, Claude Code, Codex, pi, a hosted endpoint, a remote control plane. bandit drives them all through one interface: declarative adapter profiles in `.bandit/harnesses/*.json`, resolved by `resolveTransport()` before every run.

## Profiles

One JSON file per harness:

```json
{
  "name": "acp",
  "command": "npx",
  "args": ["--yes", "@agentclientprotocol/claude-agent-acp"],
  "protocol": "acp",
  "capabilities": { "streaming": true, "cancel": true, "sessions": true, "models": true },
  "env": {},
  "model": "glm-5.3-flash:cloud",
  "gateway": { "baseUrl": "http://localhost:11434", "headers": { "x-api-key": "ollama" } }
}
```

| Field | Meaning |
|---|---|
| `name` | the `--transport` / `config.json transport` value |
| `command`, `args` | how to spawn the harness (headless: prompt appended to argv) |
| `protocol` | `headless` \| `acp` \| `herdr` \| `uhp` — the wire shape |
| `capabilities` | what this harness advertises (streaming, cancel, sessions, models) |
| `env` | extra environment for the agent process |
| `model` | ACP session model preference (`provider/id` or bare id) |
| `gateway` | ACP client-managed LLM routing: any Anthropic-protocol endpoint + headers |

## The four protocols

| Protocol | How it runs | Good for |
|---|---|---|
| `headless` | spawn CLI with prompt on argv, collect stdout, gate on exit | opencode / claude / codex / pi one-shots; the default |
| `acp` | [Agent Client Protocol](https://agentclientprotocol.com) v1 over stdio (JSON-RPC) | Claude Code, Codex, OMP, pi via adapters — and any harness-remote-style control plane |
| `herdr` | interactive TUI in a visible pane, prompt injected after boot | watching and steering mid-run |
| `uhp` | HTTP `POST /v1/responses` | hosted endpoints with an API key |

## ACP: the universal spoke

bandit's ACP client (src/runner.ts) implements the minimal v1 lifecycle:

```
initialize (advertise gateway capability, fs read/write)
  → authenticate (only when profile declares a gateway)
  → session/new (cwd = card's folder)
  → session/set_mode acceptEdits     # a factory turn must never block on permission
  → session/prompt                   # rendered serf prompt + card vars
  ◀ session/update agent_message_chunk (collected as the run's output)
  ◀ stopReason                       # end_turn | max_tokens | cancelled | refusal
```

Client-side behaviors:

- **Permissions**: `session/request_permission` is answered automatically with the first `allow_*` option. The factory's real safety layer is the verification gate + budgets — not per-tool prompts.
- **fs requests**: `fs/read_text_file` / `fs/write_text_file` are served directly from the card's cwd (the adapter may not have its own file access).
- **Cancellation**: timeout kills the process; a stopReason of `refusal` is surfaced as a run error.

### Model routing

The adapter resolves the model at session create from `ANTHROPIC_MODEL`; it lands in the session's `configOptions` catalog *and* becomes the current model. bandit sets this env from the profile's `model` field (`provider/id` normalized — `ollama/x` → provider `ollama`, model `x`). `set_config_option` can only select within the session-create catalog, so env is the reliable route.

### Gateway auth (any LLM backend)

When the profile declares a `gateway`, bandit advertises `auth._meta.gateway` at initialize and answers `authenticate` with the profile's `baseUrl` + headers. The adapter then routes every LLM call there — it never needs its own provider login. Verified end-to-end:

```json
"gateway": { "baseUrl": "http://localhost:11434", "headers": { "x-api-key": "ollama" } },
"model": "glm-5.3-flash:cloud"
```

This drives Claude Code's own ACP adapter entirely from a local ollama model — the full actor-critic loop converges with zero tokens billed to any cloud provider. Any endpoint speaking the Anthropic API shape works the same way: LiteLLM, a corporate gateway, a hosted proxy.

### Claude adapter auth paths (no gateway)

- Claude subscription login (`claude` CLI logged in) — adapter uses it directly
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` in the profile's `env`
- Gateway auth (above) — strongest for provider-agnostic setups

## Bundled profiles

| Profile | Command | Protocol | Notes |
|---|---|---|---|
| `headless` | `opencode run` | headless | default; prompt on argv |
| `acp` | `npx @agentclientprotocol/claude-agent-acp` | acp | Claude Code's official adapter |
| `acp-codex` | `npx @zed-industries/codex-acp` | acp | Codex CLI via ACP |
| `herdr` | `opencode` | herdr | visible pane, steerable |

`bandit init` writes these (never overwrites existing edits). `bandit harnesses` lists installed profiles with the active one marked; `bandit harnesses add <name> <command> [args...] [--protocol acp]` creates a custom profile.

## Harness-remote compatibility

The ACP transport speaks the same shape [harness-remote](https://github.com/giuliastro/harness-remote) exposes — native-session control planes over agent-scoped routes. A remote machine is a profile whose `command` points at the bridge; the factory doesn't change. Sessions stay native to the harness that created them; bandit adds the work-continuity layer (cards, verdicts, gates) on top.

## Choosing per run

```bash
bandit start --transport acp                  # this run + persisted to config.json
bandit start --agent pi --model ollama/glm-5.3-flash:cloud --once   # headless override, one run
bandit .                                       # interactive picker (agent → live model catalog → visibility)
```

Model specs are normalized everywhere: `provider/id` (e.g. `ollama/glm-5.3-flash:cloud`) is accepted by every harness; pi additionally accepts bare ids; claude strips the provider prefix automatically.