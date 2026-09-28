# Kitsune 🦊

A personal agent that watches your inbox and turns work into **approved** coding sessions.

A task lands in ClickUp → Kitsune classifies it with your coding CLI (`claude`, `codex` or `agy`,
headless, using the subscription you already have) → proposes a session on **Telegram** → you tap
✅ → it launches the session in [Ronin](https://github.com/cesarhermosillo/ronin) over MCP → and
pings you when the agent asks something or finishes.

Nothing that creates or changes anything runs without your explicit approval.

## How it works

- **Connectors**: ClickUp (tasks assigned to you, mentions, comments on your tasks).
- **Brain**: one headless call per event. Output is validated against a schema and against Ronin's
  catalog, and any of your three secrets that appears in it is replaced by `[redactado]` before it
  is parsed, stored or sent. Third-party content is treated as data, never as instructions.

  | Engine | Tool-less? |
  |---|---|
  | `claude` | **Yes** — `--tools ""`, `--strict-mcp-config`. Recommended, especially for untrusted inboxes. |
  | `codex` | **No** — not tool-less; opt-in. Runs with `-s read-only --disable shell_tool --disable unified_exec`, but Codex has no verifiable "no tools" mode, so the model may still be able to read local files. Use `claude` for untrusted inboxes. |
  | `agy` | Runs with `--sandbox`; not verified as tool-less. Same advice as `codex`. |
- **Telegram**: proposals with ✅ / ✏️ / ❌, retries, expiry, and replies forwarded to the agent.
- **Ronin (MCP)**: `listar_repos_y_workflows`, `crear_sesion`, `estado_sesiones`, `responder_sesion`.
- **Local state**: SQLite at `~/.kitsune/kitsune.db`, including a full audit log.

## Setup

1. Node ≥ 22.13, Ronin running locally, and at least one of `claude`, `codex`, `agy`.
2. `npm install && npm run build`
3. `mkdir -p ~/.kitsune && cp config.example.json ~/.kitsune/config.json` and edit it.
4. Create `~/.kitsune/.env` with `CLICKUP_TOKEN`, `TELEGRAM_BOT_TOKEN`,
   `RONIN_CAPABILITY_TOKEN`, then `chmod 600 ~/.kitsune/.env`.
   See [docs/telegram-setup.md](docs/telegram-setup.md) for the bot.
5. `npm run doctor`, then `npm start`.

## Roadmap

Pet UI · voice · iPhone app (LAN first, then online) · more connectors · auto-approval rules.

## License

MIT
