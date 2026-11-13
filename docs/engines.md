# Engines: Claude, Codex, Cursor, OpenCode, Hermes

mevo runs every role on Claude Code until you turn other engines on. Each engine is a CLI on
this Mac, signed in with your own account; mevo drives it headless inside the ticket's
worktree, with the same brief and the same contract (commits, `ARM-SUMMARY.md`, `PR-BODY.md`,
`VISUAL.json`, screenshots).

| Role | Default | What it does |
| --- | --- | --- |
| implementer (lite / full) | `claude` | builds the ticket |
| reviewer | `claude` | wiki review pass, fixes gating findings |
| supervisor | `opposite` | re-runs the gates, then a different vendor checks the work against the ticket |
| visual | `claude` | the "Run visual check" button |
| curator | `off` | reads PR feedback once a day and proposes team rules |

`opposite` means: if Claude implemented, the first enabled of Codex, Cursor, OpenCode, Hermes checks;
otherwise Claude checks. With no other engine enabled, the supervisor is skipped.

## 1. Codex (your ChatGPT plan)

```sh
npm i -g @openai/codex        # or: brew install --cask codex
codex login                   # opens the browser, sign in with ChatGPT
codex login status
```

Playwright, so Codex can do visual checks, in `~/.codex/config.toml`:

```toml
[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@latest"]
```

## 2. Cursor (your Cursor plan)

```sh
curl https://cursor.com/install -fsS | bash
agent login                   # browser sign-in with your Cursor account
agent status
agent models                  # the models your plan includes; pick one for the config
```

Playwright in `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] } } }
```

## 3. OpenCode (free models, or any provider you already pay for)

```sh
npm i -g opencode-ai          # or: brew install sst/tap/opencode
opencode auth login           # pick a provider: OpenCode Zen (has free models), OpenRouter, Copilot, ...
opencode auth list
opencode models               # ids are provider/model; pick one for the config
```

- Free: an OpenCode Zen free model, or an OpenRouter model whose id ends in `:free`
  (`openrouter/qwen/qwen3-coder:free`). Free models are slower and rate limited; give them lite work.
- A plan you already have (GitHub Copilot, ChatGPT) works through its provider, so it costs
  nothing extra.
- mevo runs it with every permission allowed (`OPENCODE_PERMISSION`), like the other engines.

Playwright in `~/.config/opencode/opencode.json`:

```json
{ "mcp": { "playwright": { "type": "local", "command": ["npx", "-y", "@playwright/mcp@latest"] } } }
```

## 4. Hermes (DeepSeek, OpenRouter, OpenAI API, local models)

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes setup                  # pick the provider and paste its API key
```

- OpenRouter (one key, many models, DeepSeek included): provider `openrouter`, model
  `deepseek/deepseek-chat` or any id from openrouter.ai/models.
- OpenAI API (pay per use, separate from ChatGPT): provider `openai-api`, model e.g. `gpt-5`.
- DeepSeek direct: provider `custom` with base URL `https://api.deepseek.com` in `hermes setup`.

Playwright in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  playwright:
    command: npx
    args: ["-y", "@playwright/mcp@latest"]
```

Hermes keeps its own memory and skills in `~/.hermes`. mevo only uses what Hermes writes to the
ticket's files, so nothing it learns there changes a lane by itself.

## 5. Turn them on

Add to `ticketflow.config.json` only what you use; anything missing keeps its default:

```json
"engines": {
  "codex": { "enabled": true, "model": "" },
  "cursor": { "enabled": true, "model": "" },
  "opencode": { "enabled": true, "model": "openrouter/qwen/qwen3-coder:free" },
  "hermes": { "enabled": true, "provider": "openrouter", "model": "deepseek/deepseek-chat" }
},
"roles": {
  "implementer": { "lite": "codex", "full": "claude" },
  "reviewer": "claude",
  "supervisor": "opposite",
  "supervisorRounds": 2,
  "visual": "claude",
  "curator": "hermes",
  "curatorAt": "19:30"
}
```

An empty `model` uses the CLI's own default. A role can name a model: `"codex:gpt-5"`,
`"cursor:sonnet-4.5"`, `"opencode:opencode/grok-code"`, `"hermes:openai-api:gpt-5"`.

Turn it on in Settings → Engines (or set it in the config and restart). It shows each engine, its version, sign-in and roles; **Test**
runs a tiny prompt through it and tells you whether mevo could read the answer.

## 6. Spend your plans before your budget

Claude reports API-priced cost on every turn; Codex and Cursor run on your subscription and
OpenCode can run free models. Settings → Budget → **Plan first** sends lanes there first:

| Plan first | Lite lanes | Full lanes |
| --- | --- | --- |
| `off` (default) | Claude until 90 % of the budget, then the plan engine | Claude until 100 %, then the plan engine |
| `lite` | plan engine | Claude until 100 % |
| `all` | plan engine | plan engine |

The plan engine is `budget.fallback` (`auto`: the first enabled of Codex, Cursor, OpenCode,
Hermes). The supervisor stays on another vendor, so plan-engine work still gets a second look
(by Claude when Codex implemented). A ticket you start on a specific engine keeps it.

```json
"budget": { "daily": 15, "monthly": 250, "planFirst": "lite", "fallback": "auto" }
```

## 7. Using them

- Start a ticket on a specific engine: the "on" picker next to Start (app), the extra ⚡ buttons
  on the Telegram message, or `/start WEB-123 lite codex`.
- Supervisor rounds: if the gates fail or the check has a proven P1 or P2, the implementer gets the
  findings and tries again, up to `supervisorRounds`; then it lands in review with the verdict.
  Unmet criteria and P3 notes alone go straight to review.
- Readiness check: `readiness.engine` ("auto" picks OpenCode when enabled, else `claude:haiku`)
  reads each new ticket with no tools before it starts.
- Learnings: Learnings page (or `/learn`, `/learnings` in Telegram). Approved rules go to
  `learnings/rules.md`; commit it like any other file.

## Notes

- Claude, Codex and Cursor run on your flat plans (OpenCode on whatever provider you signed in); the journal shows tokens and minutes for them,
  dollars only where the CLI reports a cost. Each plan has its own usage limits.
- Codex runs with `--sandbox danger-full-access` and Cursor with `--force`, the same trust level
  Claude lanes already have (`bypassPermissions`): they need installs, the dev server and the
  browser. Keep mevo on a machine you are fine giving that access.
