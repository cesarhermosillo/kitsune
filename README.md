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
  If a proposal can't be delivered, it is re-sent every minute while it is pending. Plain notices
  (mentions, errors, finished sessions) are best-effort and are not re-sent. Button taps are
  handled at most once: if handling one fails it is logged and audited, never retried.
  Tapping ✅ doesn't launch right away: it asks which workflow to launch with. You get a row per
  favorite from `favoriteWorkflows` (in that order, skipping any no longer in Ronin's catalog),
  with the classifier's suggested workflow starred (⭐) — placed first if it isn't already one of
  your favorites — and a ⚠️ merge/deploy tag on any workflow whose stages include a merge or
  deploy step. `Otro…` opens the full catalog with the same labels; `Cancelar` leaves the proposal
  pending so you can tap ✅ again later. If a session appears stuck in a shell (not `working` or
  `idle`, its flow unfinished) for two checks in a row, Kitsune sends a 💤 notice and stops
  watching it.
- **Ronin (MCP)**: `listar_repos_y_workflows`, `crear_sesion`, `estado_sesiones`, `responder_sesion`.
- **Local state**: SQLite at `~/.kitsune/kitsune.db`, including a full audit log.

## Setup

1. Node ≥ 22.13, Ronin running locally **with the MCP session tools** (`crear_sesion`,
   `estado_sesiones`, `responder_sesion` — branch `feat/mcp-sesiones` or later), and at least one
   of `claude`, `codex`, `agy`.
2. `npm install` (builds via `prepare`; or run `npm run build`).
3. `mkdir -m 700 -p ~/.kitsune && cp config.example.json ~/.kitsune/config.json` and edit it,
   including `favoriteWorkflows` (workflow names from Ronin's catalog, shown first and in that
   order in the workflow selector — defaults to `[]`).
4. Create `~/.kitsune/.env` with `CLICKUP_TOKEN`, `TELEGRAM_BOT_TOKEN`,
   `RONIN_CAPABILITY_TOKEN`, then `chmod 600 ~/.kitsune/.env`.
   `RONIN_CAPABILITY_TOKEN` is the content of the `capability-token` file in Ronin's data
   directory (`COWORK_DATA_DIR`, or Ronin's default data dir).
   See [docs/telegram-setup.md](docs/telegram-setup.md) for the bot.
5. `npm run doctor`, then `npm start`.

## Desktop pet (pet/)

A transparent, always-on-top desktop fox (Tauri 2) that mirrors what Kitsune is doing: it sits on
your screen, plays an idle/working/asking/celebrating/sad animation depending on the daemon's
state, and pops a speech bubble for new proposals, questions, finished sessions and errors. Clicks
pass through the transparent parts of the window except over opaque fox pixels or the visible
bubble, so it never blocks whatever is behind it.

**Requirements**: Rust (`rustup`) and, on macOS, the Xcode Command Line Tools
(`xcode-select --install`).

**Develop**:

```bash
cd pet && npm install && npm run sprites && npm run tauri dev
```

`npm run tauri dev` starts the Vite dev server on `http://localhost:1420` and opens the Tauri
window pointed at it. Add `"localApi": { "devOrigins": ["http://localhost:1420"] }` to
`~/.kitsune/config.json` so the daemon accepts requests from the dev webview's origin (the
packaged app talks to the daemon over `http://127.0.0.1:47823`, authenticating with the token in
`~/.kitsune/pet-token`).

**Build the app**:

```bash
npm run tauri build
```

produces `Kitsune.app` (and a `.dmg`) under `pet/src-tauri/target/release/bundle/`.

**States**: the fox's animation and bubble reflect the daemon's status —

- **sleeping** — no connection to Kitsune, or "No molestar" (DND) is on.
- **idle** — connected, nothing pending.
- **sniffing** — an inbox event is being triaged.
- **alert** — one or more proposals are waiting for your approval on Telegram.
- **working** — at least one coding session is running.
- **asking** — a running session needs input.
- **celebrate** — a session just finished successfully (briefly, then back to idle).
- **sad** — the last triage failed, a session died, or an error was reported (briefly).

Right-click (or the tray icon) opens a menu: **Ocultar / Mostrar** the window, toggle **No
molestar**, **Abrir Ronin**, pick the fox's **Tamaño** (2×/3×/4×), and **Salir**.

## Roadmap

Pet UI · voice · iPhone app (LAN first, then online) · more connectors · auto-approval rules.

## License

MIT
