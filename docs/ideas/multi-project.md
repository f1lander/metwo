# Idea: more than one project per machine

Status: parked. Today mevo is one daemon per machine, for one repo and one Linear team. This note is the plan for when we pick it up.

## The short way: two instances side by side

Run a second mevo for another project, each with its own port, data, config and bot. No shared Linear account, no project picker: each instance stays exactly what mevo is today.

### What collides today

| What | Today | Change |
| --- | --- | --- |
| API port | 4747 hardcoded in the desktop app (`daemon.rs` `PORT`), the web client (`lib/api.ts` `API`) and `vite.config.ts` | `server.port` from config, and the app and web read it (see below) |
| Data | `data/` (`state.json`, logs, worktree records) | already `METWO_DATA_DIR`; each instance gets its own |
| Config | `ticketflow.config.json` at the repo root | `METWO_CONFIG=path/to/other.config.json` |
| Secrets | `.env` at the repo root | `METWO_ENV=path/to/other.env` (its own `LINEAR_API_KEY`, bot token, Slack tokens) |
| Telegram | one bot per token; two daemons on the same token make Telegram drop one | one bot per instance (BotFather, 1 minute) |
| Worktree dev ports | `pipeline.portBase` 3100 in both | a different `portBase` per instance (3100, 3300…) |
| Local e2e stack | one anvil and fixed ports; the "one e2e at a time" lock lives inside one process | either a different `e2e` port set per instance, or a file lock in the stack's folder so two daemons queue on it |
| Lanes and spend | `maxParallel` and the budget are per daemon | fine to start; note that 2 × 2 lanes means 4 agents on the machine |
| Desktop app | supervises one daemon, one tray icon | open the app with `METWO_ROOT` / `METWO_PORT`, or a second app bundle per project |
| Code watch / restart | per instance | already works per instance |

### Steps

1. **Port from config everywhere.**
   - The daemon already reads `server.port`.
   - The desktop app reads `METWO_PORT` (default 4747) for `port_open`, `post` and the window URL.
   - The web client takes the API from the page's own origin when served by the daemon. In the desktop app it reads the port from a Tauri command. `vite.config.ts` proxies to `METWO_PORT`.
2. **Config, env and data paths from env vars.**
   - `METWO_CONFIG`, `METWO_ENV` and `METWO_DATA_DIR`, with today's paths as defaults.
   - `pnpm daemon` keeps working unchanged.
   - Add `pnpm daemon:as <name>` to load `instances/<name>/{config.json,.env,data/}`.
3. **Ports that can't collide.**
   - At start, refuse to boot if `portBase..portBase+maxParallel*10` overlaps a port another instance has claimed. Each instance records its claim in a small file in `~/.mevo/instances.json`.
   - Same for the e2e ports.
4. **Shared e2e stack.**
   - Move the e2e lock from memory to a lock file (`~/.mevo/e2e.lock` with pid and ticket), so two instances queue instead of fighting over anvil.
   - The waiting run shows "waiting for the e2e stack (used by <instance> · WEB-123)".
5. **Desktop app.**
   - First version: launch the app twice with different env (`METWO_ROOT`, `METWO_PORT`, `METWO_NAME`). The tray title gets the name: "mevo · chekku".
   - Later: one app with an instance switcher.
6. **Name on everything.**
   - `instance.name` in config, shown in the header, the window title, the Telegram bot's messages and Slack posts.
   - This avoids "which mevo said this".

Estimate: 1–2 days for steps 1–4, plus half a day for the desktop app.

### Guard rails

- Two instances must never point at the same repo: worktrees and branches would clash. Check at boot with the claim file.
- The budget is per instance. Show "other instances spent $X today" from the claim file, for awareness only.

## The long way, later: one mevo, many projects

The sellable version: install once, then "Add project".

- `projects: [{ id, repo, linear: { apiKey?, team }, commands, e2e, autopilot }]`, with `project` on every ticket and review.
- One shared lane queue and budget, one Telegram bot with a `[project]` prefix, a project picker in the app.
- It costs more because:
  - about 100 places read `cfg.repo` / `cfg.linear` / `cfg.e2e` directly;
  - there would be Linear and GitHub clients per project, possibly with different accounts;
  - every page needs project filters;
  - Settings would split into global and per-project.
- Estimate: 3–5 days for the core, 1–2 more for onboarding and Telegram/Slack.

Doing the short way first is not wasted: the port, path and lock work carries over.
