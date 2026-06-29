<h1 align="center">codex-channel-octo</h1>

<p align="center">
  An independent Node.js gateway that bridges <a href="https://developers.openai.com/codex">OpenAI Codex</a> (via <a href="https://www.npmjs.com/package/@openai/codex-sdk"><code>@openai/codex-sdk</code></a>) to <a href="https://github.com/nicco-io/octo">Octo</a> IM.
</p>

<p align="center">
  <a href="https://github.com/Mininglamp-OSS/codex-channel-octo/actions"><img src="https://github.com/Mininglamp-OSS/codex-channel-octo/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node.js version">
  <img src="https://img.shields.io/badge/status-early%20test-orange" alt="Status: early test">
</p>

<p align="center">
  <b>English</b> · <a href="./README.zh-CN.md">简体中文</a>
</p>

---

> ⚠️ **Early test release (v0.1.0).** The core path (registration / connection / multi-turn chat / multi-bot) is verified and working, but the project is still maturing. **Known gaps:** no scheduled tasks (cron) and no skills yet — see the [CHANGELOG](./CHANGELOG.md). It mirrors its sibling [`cc-channel-octo`](https://github.com/Mininglamp-OSS/cc-channel-octo) (the Claude Code edition); only the agent core differs.

## What it is

A long-running process: register as an Octo bot → connect over WebSocket to receive messages → run a coding task with local Codex → post the reply back. Supports DM / group (@mention) / community topics, multi-turn conversations, multiple bots in one process, and config hot-reload.

**Headline feature — IM ↔ terminal Codex interop (opt-in):** each bot conversation maps to a Codex thread. With sharing enabled, you can resume a bot's group conversation from your own terminal via `codex exec resume <threadId>`, and vice versa.

## Install

```bash
npm install -g @mininglamp-oss/codex-channel-octo
```

Depends on `@openai/codex-sdk`, which bundles the Codex runtime (no separate Codex CLI install needed). Requires Node ≥ 22.

## Configuration

Two-layer, bot-first:

- **Global** `~/.codex-channel-octo/config.json` — shared defaults + the `bots` list, **no token**. See [`config.example.json`](./config.example.json).
- **Per-bot** `~/.codex-channel-octo/<id>/config.json` — that bot's `botToken` + overrides. See [`config.bot.example.json`](./config.bot.example.json). Each bot is a self-contained subtree: `<baseDir>/<id>/{config.json, SOUL.md, data/, workspace/, codex-home/}`.

Minimal example:

```jsonc
// ~/.codex-channel-octo/config.json
{ "apiUrl": "https://your-octo-instance.com", "bots": [{ "id": "default" }] }
// ~/.codex-channel-octo/default/config.json
{ "botToken": "bf_YOUR_BOT_TOKEN" }
```

### Codex authentication

Each bot has its own `CODEX_HOME` (`<id>/codex-home`) by default and must be authenticated, one of:

1. `CODEX_HOME=~/.codex-channel-octo/default/codex-home codex login`
2. Set `sdk.codexApiKey` (and `sdk.codexBaseUrl` if needed) in the per-bot config.

> An unauthenticated isolated home falls back to `api.openai.com` and returns 401.

## Run

```bash
codex-channel-octo start        # start in background (supervisor)
codex-channel-octo status       # show status
codex-channel-octo stop         # graceful stop
npm start                       # foreground (debug)
```

## Security model

IM input is **untrusted**; the permission boundary is the **sandbox**, not the prompt:

- **`sandboxMode` defaults to `read-only`** — the first release targets safe Q&A / code review. To let a bot edit files you must set **both** `allowWorkspaceWrite: true` and `sandboxMode: "workspace-write"` (a double switch to guard against misconfig).
- `danger-full-access` is always rejected.
- `networkAccessEnabled` / `webSearchEnabled` are off by default.
- A non-overridable security prefix (anti-injection) is written into each session's sandbox `AGENTS.md` and restated atop the prompt (defense in depth, but only a soft constraint).
- Each bot has its own `CODEX_HOME`, so IM content does not land in your personal `~/.codex` by default.

## IM ↔ terminal interop (opt-in)

Isolated by default. To enable interop, point a per-bot `sdk.codexHome` at your personal `~/.codex`:

```jsonc
{ "botToken": "bf_...", "sdk": { "codexHome": "/Users/you/.codex" } }
```

After that, a bot's group conversation can be resumed in your terminal with `codex exec resume <threadId>`. **Note: IM content then enters your personal Codex session history.**

## Differences from the Claude edition

| | cc-channel-octo | codex-channel-octo |
|---|---|---|
| Core | `@anthropic-ai/claude-agent-sdk` (in-process) | `@openai/codex-sdk` (spawns local codex) |
| Session | SDK session id | Codex thread id (stored in `~/.codex/sessions`, terminal-resumable) |
| Streaming | per-chunk | final message delivered whole + intermediate steps as progress |
| Permissions | permissionMode / allowedTools | sandboxMode / approvalPolicy |
| System prompt | SDK preset + append | session sandbox `AGENTS.md` |

## Development

```bash
npm install
npm run build       # tsc → dist/
npm test            # vitest
npm run lint        # eslint --max-warnings 0
npm run type-check  # tsc --noEmit
```

## License

Apache-2.0
