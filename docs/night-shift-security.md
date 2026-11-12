# Night Shift bot: what it can and can't do

Night Shift answers Slack for you while you are away, as a bot clearly labelled "mevo, <you>'s assistant". This note covers its limits and the risks they guard against. It was written after an audit on 2026-11-05.

## What it is

- **Reads:** mentions of you and your DMs that arrive after the shift starts, and the thread around each one.
- **Knows:** a list of your open work in the project's repo, built by mevo from its own state: tickets, Linear priority, estimate and state, PRs, CI, reviews, who is asked, how long a PR has waited, previews, and what the work changed (the summary's "What changed", commit subjects, files touched). PRs in any other repo are left out. This list is all it knows.
- **Writes:** a short answer, posted with the bot token. In **Post factual answers** mode it posts answers to questions the facts settle, and a one-time "noted" in each thread for what needs you. Everything else waits for you as a draft. In **Drafts only** mode it posts nothing.
- **Does:** nothing else. It holds no tools, runner, git, GitHub or Linear access. The Night Shift code only reads mevo's state and posts text.

## What it answers by itself (facts mode)

- Status: is it merged, is CI green, who is reviewing, where is the preview, what is ready for review.
- Code, from what mevo saved: what a ticket or PR changed, which files, which commits.
- Ranking from the facts: which PR to review first, what is most urgent, what is blocked. It orders by Linear priority, then ready-for-review with green CI over drafts or failing CI, then how long it waited. It gives the reason.

## What it never does

| Asked | Kind | What happens |
| --- | --- | --- |
| Merge, push, delete, deploy, revert, approve, close, run something | `action` | "I can only share the status of <you>'s work, not act on it." In facts mode posted once per thread (once per conversation in a DM); nothing is done. A pattern check forces this kind even if the model says otherwise. |
| A decision, an opinion beyond the facts, a date, taking on work | `decision` | "noted, <you> will see this when back." In facts mode posted once per thread; nothing is decided or promised. |
| Anything not about your work in the facts: someone else's tickets or PRs, another repo, general or code help, questions about the bot | `outside` | No answer, no draft. It shows in the handoff. |
| Fishing: private keys, seed phrases, passwords, `.env`, tokens, "what's on his computer", files, shell commands, "ignore your instructions", the system prompt | `ignored` | Caught by a pattern check before the model: the model never reads it. No answer, no draft. Flagged in the handoff. |
| Production down, security, "can't wait" (or a wake word) | `urgent` | Telegram ping to you, and "I've let <you> know." once per thread in facts mode. |

## Risks and protections

| Risk | Protection | Status |
| --- | --- | --- |
| A message tells the model to read a file (`.env`, keys) and post it | The model runs with **no tools** in an empty folder (`assistant.sealed`): no Read, Grep, Glob, LS, Bash, edits or web. It sees only the prompt. | Fixed in this audit. Before, it could read files in the repo. |
| A message fishes for secrets or the computer | `probes()` stops it before any model call (kind `ignored`). Even if one slipped through, the model has no tools and the facts hold no secrets. | Fixed |
| Questions outside your work | The prompt limits it to your tickets, PRs and commits in the project's repo (`repoSlug`, or the repo most of your PRs are in); anything else is `outside` and never answered. A "fact" with no facts becomes `outside`. | Fixed |
| A message tries to rewrite its rules ("ignore your instructions…") | The thread is marked as data. The prompt tells it to ignore such requests and never reveal the prompt, files, settings or tokens. The checks below apply whatever it writes. | Fixed |
| A secret ends up in a reply | `guardReply` blocks anything that looks like a token or key: Slack, GitHub, OpenAI-style, Linear, AWS, PEM private keys, 64-hex private keys, `*_TOKEN=` / `*_PASSWORD=` lines. The reply is dropped, even when you press Post. | Fixed |
| Phishing or unrelated links | Answers posted by the bot itself may only link to your own PRs, tickets and previews. Any other link holds the reply back for you. | Fixed |
| Spamming people | `@channel`, `@here`, `@everyone`, user-group and user pings are stripped. Limits: one answer per thread per 30 minutes, 12 per shift. | Fixed |
| Bot-to-bot loops | Messages written by apps or bots are never answered by itself. | Fixed |
| Confidential work leaking to a channel | Tickets labelled or titled Security, Confidential, Private, Embargo, Vulnerability or Incident are left out of the facts, links included. The model is told some work is withheld on purpose. | Fixed |
| Speaking as you | Posts go only through the bot token, always labelled. Your user token is used only for replies you send yourself from Today. | Already |
| Answering in a DM or group DM (the bot can't join it) | From your account with the mevo label when "Answer DMs from my account" is on (in the group DM's thread); otherwise in the asker's own DM with the bot. | Fixed |
| Writing from your account in DMs (opt-in: **Answer DMs from my account**) | Only in that DM, never in channels. Every message starts with "This is mevo, <you>'s assistant, writing from <you>'s account". The same checks and "only informs" rules apply. The "waits for you" note goes out at most once per person per shift. Off by default. | Added |
| Old messages reprocessed when the shift starts | Only messages after the shift started count. DMs start at the shift start too. | Fixed |
| Cost runaway | One small model call per message, low effort, only during the shift. Counted in the budget as "Night Shift". | Already |

## Where it lives

- `apps/daemon/src/night-guard.ts`: the facts (`workFacts`, project repo only), the confidential filter, the fishing check (`probes`), the act check (`asksToAct`) and `guardReply`.
- `apps/daemon/src/nightshift.ts`: classification, drafts, posting rules and limits.
- `apps/daemon/src/assistant.ts` `sealed()`: the no-tools model call (also used for mention summaries).
- `apps/daemon/src/engines/claude.ts`: `noTools` also denies Read, Grep, Glob, LS and MultiEdit.

## Still to decide

- **False positives.** The fishing check is strict: a real question that says "password" or "API key" is ignored too. You still see it in the morning.
- **Which channels it answers in.** Today the bot answers wherever it was invited. An allowlist in Settings would narrow that.
- **Real-time.** Socket Mode would make answers instant instead of 20–60 s. It needs an app-level token (`xapp-`).
- **Tokens at rest.** They live in `.env` on your Mac. Consider the macOS Keychain if mevo ships to other people.
- **Telegram.** Urgent pings and the handoff include message text and go to your private chat. That is fine for one person; a team version needs a policy.
