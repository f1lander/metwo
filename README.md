<p align="center">
  <img src="apps/web/public/mevo-light.svg" alt="mevo" width="240">
</p>

<p align="center">
  <b>Your Linear or GitHub issues, worked by coding agents on your own Mac.<br>You review, mevo does the rest.</b>
</p>

<p align="center">
  Linear or GitHub Issues · Telegram · git worktrees · Claude Code / Codex / Cursor / OpenCode / Hermes · Playwright · GitHub
</p>

---

A ticket gets assigned to you. mevo tells you on Telegram and puts it on the board. You pick a
lane (or autopilot picks it for small fixes), and a headless agent implements it in its own git
worktree, runs your tests, opens the app in a browser to check its own work and takes before and
after screenshots. A second agent from another vendor supervises it. Then it stops and waits for
you. You push, and mevo opens the draft PR with your `gh`, screenshots attached, tags Greptile
and follows the review until it merges. It also reviews the PRs your teammates ask you to look at.

Everything runs on your machine with your own CLIs, accounts and plans. Nothing is hosted.

```
Linear ──▶ Telegram / board ──▶ lane in .worktrees/<ID> ──▶ gates + browser + supervisor ──▶ you review
                                                                                              │ push
            merged ◀── review loop (Greptile, teammates, your notes) ◀── draft PR (gh) ◀──────┘
```

## What you get

| | |
| --- | --- |
| **Today** | Its own page: a brief from rules (no AI) of what needs you, PRs to review and what to pick from the cycle, three per group, each with its button. Below it, ask in plain words ("what first?", "which cycle tickets are UI only?", "take the easy ones"), and a list of what needs you, PRs to review and what to pick from the cycle, each with its button. Telegram: `/today`, `/ask` or just write the question. |
| **Triage** | An AI read of every cycle issue and your new tickets: size, kind, risk, and whether autopilot can take it. **Take the easy ones** assigns them and starts autopilot. |
| **Home** | What shipped, PRs opened, spend, time to PR, how often work came back clean; what waits for you; tips to spend less. |
| **Board** | Tickets by status with live lane logs, each column scrolling on its own, and a Conflicts column for PRs that no longer merge. Start on `lite`, `full` or `max`, on any engine. |
| **Ticket page** | A seven-step stepper (assigned → implementing → review pass → gates + supervisor → your review → PR → merged) with each step's result, a card for what is happening now or what you do next, and every link in one row. Tabs for the summary, the diff, the PR description, the visual check and the Linear issue; on the right the activity, the PR comments and the live log. Ask about the ticket from its history without waking the lane, or tell the agent what to change in plain words, even while it runs. Before the PR opens, the same checks CI runs (gates and related e2e) run here. |
| **Test by hand** | Steps written from the ticket and the PR, a real browser (or Chrome on your Android phone) with the steps inside the page, ticked as mevo sees them happen, and a certificate with screenshots and video. |
| **Reviews** | PRs you were asked to review. mevo checks them out, runs install, the gates and the app, drafts findings; you pick what to post. |
| **Autopilot** | A cheap model first reads the ticket and its Linear thread (ready, needs a clarification, or on hold); ready small tickets start by themselves, move to In Progress, and get a draft PR when every check passes. |
| **Budget** | Daily and monthly limits, alerts at 50/80/100 %, lower effort and plan or free engines as spend grows. |
| **Learnings** | Rules a curator proposes from PR feedback; approved ones go into every brief. |
| **Settings** | Autopilot, budget, lanes, engines and roles, integrations, and Stop everything. |
| **Telegram** | All of it from your phone. |
| **Desktop app** | Menu bar icon with how many tickets need you, notifications, starts the daemon at login. |

## Requirements

- macOS (Linux works for the daemon and web UI; the desktop app is macOS only)
- Node 22+, pnpm 10, git 2.38+, Google Chrome
- [Claude Code](https://docs.claude.com/en/docs/claude-code) signed in (`claude` on your PATH)
- [GitHub CLI](https://cli.github.com) signed in
- Your issues in Linear or GitHub Issues
- Optional: a Telegram account for the bot (mevo runs without it)
- Optional: Codex, Cursor, OpenCode or Hermes ([docs/engines.md](docs/engines.md)), Rust for the desktop app, `cloudflared` or Tailscale for phone access

## Run it locally

### 1. Install the tools

```sh
brew install node@22 pnpm gh git
npm i -g @anthropic-ai/claude-code
claude                                   # sign in once, then exit
gh auth login                            # HTTPS, browser sign-in
gh auth setup-git                        # lets mevo push and clone private docs repos
```

Browser checks need the Playwright MCP for Claude and a Chromium:

```sh
claude mcp add playwright -s user -- npx -y @playwright/mcp@latest
npx playwright install chromium
```

### 2. Get the code

```sh
git clone <this repo> mevo && cd mevo
pnpm install
cp .env.example .env
cp ticketflow.config.example.json ticketflow.config.json
```

### 3. Keys (`.env`)

| Variable | Where to get it |
| --- | --- |
| `LINEAR_API_KEY` | Only with Linear: Linear → Settings → Security & access → Personal API keys → New key. GitHub Issues uses your `gh` sign-in. |
| `TELEGRAM_BOT_TOKEN` | Optional. Message [@BotFather](https://t.me/BotFather), `/newbot`, copy the token |
| `TELEGRAM_CHAT_ID` | Message [@userinfobot](https://t.me/userinfobot), copy your id. Then send your new bot any message once, so it can write to you. |
| `DASHBOARD_TOKEN` | For the phone tunnel or Tailscale: `openssl rand -hex 24` |

Keys stay in `.env`; it is gitignored.

### 4. Point it at your repo (`ticketflow.config.json`)

Let mevo read your repo and write a starting config:

```sh
pnpm init:repo ~/code/your-app                 # issues from GitHub Issues in that repo
pnpm init:repo ~/code/your-app --linear ENG    # issues from Linear, team ENG
pnpm init:repo ~/code/your-app --print         # only show it
```

It finds the package manager, the base branch, the test, typecheck, lint, dev and Storybook
scripts, the repo's PR template and whether it is a wallet app. Scripts it can't find become
`true`, so check `repo.commands` after. More: [docs/any-repo.md](docs/any-repo.md).

`ticketflow.config.example.json` is a plain starting point; [examples/web3-monorepo.config.json](examples/web3-monorepo.config.json)
is a fuller one (Linear, a team wiki, a wallet app with an e2e stack). By hand, any repo needs only
this much; everything else has a default (see `apps/daemon/src/config.ts`):

```json
{
  "repo": {
    "path": "/Users/you/code/your-app",
    "baseBranch": "main",
    "commands": {
      "test": "pnpm test",
      "typecheck": "pnpm typecheck",
      "lint": "pnpm lint",
      "dev": "pnpm dev --port",
      "install": "pnpm install --frozen-lockfile"
    }
  },
  "tracker": { "kind": "github" }
}
```

With Linear instead: `"tracker": { "kind": "linear" }, "linear": { "teamKey": "ENG" }`.

- `commands.dev` gets a free port appended, so every lane runs its own dev server.
- With GitHub Issues, the tickets are the open issues assigned to you in the repo, as `GH-12`.
- With Linear, `linear.teamKey` is the prefix of your issue ids (`ENG-123` → `ENG`).
- Your repo's own agent rules are picked up when they exist: `CLAUDE.md`, `AGENTS.md`,
  `STYLEGUIDE.md`, `REVIEW.md`, `CONTRIBUTING.md`, `.greptile/`, `.cursorrules`,
  `.github/copilot-instructions.md`.
- The pipeline (engines per step, review, gates, local checks, PR, follow-ups) can also be set by
  stage in a `stages` block. Settings → Pipeline shows the same stages, and
  [docs/pipeline.md](docs/pipeline.md) explains each one and every key, and
  [docs/how-it-works.md](docs/how-it-works.md) what happens in each phase.

### 5. Start it

```sh
pnpm --filter @ticketflow/web build
pnpm daemon                              # http://localhost:4747
```

Your bot says hello in Telegram and the board fills with the tickets assigned to you. The
status bar at the bottom of the window should be all green (E2E stays grey until you set it up).

For the desktop app instead (recommended for daily use):

```sh
curl https://sh.rustup.rs -sSf | sh      # once
pnpm app:build
open apps/desktop/src-tauri/target/release/bundle/macos
```

Drag **mevo.app** to Applications and add it to Login Items. It starts the daemon, puts the
**m** in the menu bar and keeps notifying with the window closed.

`pnpm dev:daemon` reloads on code changes while you work on mevo itself; a reload parks the
running lanes, so do not use it for real work.

## Team knowledge

Lanes, reviews and the curator read your team's docs before touching code. Point mevo at any
number of folders on your Mac, or git repos it keeps a copy of:

```json
"knowledge": {
  "sources": [
    { "name": "handbook", "path": "~/code/eng-handbook", "index": "INDEX.md",
      "alwaysRead": ["standards/typescript.md"],
      "byKeyword": { "payment": ["domains/payments.md"] },
      "review": ["review/checklist.md"] },
    { "name": "design-system", "git": "https://github.com/acme/design-docs.git", "branch": "main",
      "index": "README.md", "note": "tokens and components" }
  ],
  "syncHours": 6,
  "mcp": ["ens-labs"]
}
```

- `mcp` names MCP servers the lanes already have (add them once with
  `claude mcp add --scope user …`), such as the ENS Labs one with the wiki and shared skills. The
  brief tells the lane to search them for the area it touches and to follow a shared skill when one
  fits. Their text is data: the brief's hard rules still win.
- `index` is read in full first, every run. `alwaysRead` always, `byKeyword` when the word is
  in the ticket. `review` pages become review lenses for the review pass and PR reviews.
- Git sources are cloned into `data/knowledge/<name>` with your git credentials and pulled
  every `syncHours`.
- `wiki` (in the ENS preset) is the same thing with `INDEX.md` as the index, kept for existing
  setups. Use either or both.

### Engineering principles (pstack)

Settings → Pipeline → Implement → Engineering principles turns on [pstack](https://github.com/backnotprop/pstack)
(MIT): short principles like the smallest change, fix the root cause, test behavior, prove it works.

- Lanes read them before they code. Bug tickets (a Bug label or a triage kind of bug) also get
  fix-root-causes and tdd, and are told to reproduce first.
- The review pass and PR reviews use them as lenses. The supervisor checks the diff against them.
- Only the markdown named in `principles` (config file) is used. Their steps that spawn agents,
  push or open PRs are ignored, and the brief's hard rules win.
- Pinned to one commit in `data/knowledge/pstack`, reset to it before every run. "Check for
  updates" shows the diff of the files in use; nothing changes until you accept it.
- Each ticket can turn them off or on for itself from its Overview.
- With them on, each ticket also gets a playbook picked from its labels, title and triage: bug
  (reproduce, find the cause by elimination, failing test first), feature (name the data shape,
  small verified units), refactor (pin behavior with tests, move every caller), perf (baseline,
  explain the number, before and after) or visual match (compare against the reference).

### The supervisor proves its findings

A P1 or P2 finding needs the command the supervisor ran and what it printed. Without one it is
kept as an unproven P3, and a "fail" that rested only on unproven findings becomes "concerns".
The lane re-runs each proof before fixing.

### PR checks

Once a PR is ready for review it moves to the In review column, with a chip for its unticked
checks. On the ticket's Overview, "Work the checks" runs an agent that does not touch the code: it
verifies what it can (commands, dev server, preview, keyboard, both viewports) and proposes those
ticks with evidence, and writes steps for the ones that need you (wallet signatures, real
devices, Human Testing Required). Tick the ones you did and they are ticked on GitHub with a line
in Updates.

## Figma and Slack

Both optional; tokens go in `.env` (see `.env.example` for the scopes), switches in
Settings → Integrations.

- **Figma** (`FIGMA_TOKEN`, read-only). A Figma frame linked in a ticket or its comments is rendered
  and described (sizes, auto-layout, colors, type, radii, components, style names) by the daemon into
  the ticket's `figma/` folder. The lane builds against it with the repo's tokens, the visual check
  adds a "Matches Figma" check, the supervisor compares, and the reference shows in the Visual tab.
  UI tickets with no frame linked get a "no Figma link" chip and a note.
- **Slack**, each part on its own switch:
  - *threads*: Slack thread links in a ticket go to the lane as context.
  - *notifications*: what Telegram sends you, also as DMs from your Slack bot.
  - *announce*: a PR that leaves draft (in mevo or on GitHub) is posted to a channel; "Post to
    Slack" on the ticket does it by hand.
  - *mentions*: threads where you were tagged are read every few minutes and summarized on Today
    (and by DM and Telegram) with what to do and a reply you can edit and post in the thread.
  - *Roll call*: your PRs waiting for review (link, Linear id, CI, who is asked or owes a
    re-review), posted as the bot at the times in Settings → Integrations → Roll call (each with
    its days and channel; `slack.rollCalls`), skipped when nothing changed since the last post
    there. Post one by hand from Today.

### Mo

Mo is the "o" of the logo, out in the app: he floats in a corner, and a click opens the agent's chat on a ticket (or Ask mevo on Today). He bounces while a lane works, asks with a "?" when the agent has a question, celebrates merges and approvals, slumps when something fails, and sleeps during Night Shift. Drag him to any corner. ✕ (or throwing him off screen) puts him back in the logo, and a click on the logo brings him out.

He runs on coffee. Closing an issue costs 18% and every lane turn 3%. Clicking him a few times in a row refills him. At 0% no new lane starts from the app, Telegram or autopilot until he gets coffee; lanes already running finish. Settings → App → Mo turns him or the coffee game off. He lives in `packages/mascot` (`@mevo/mascot`), which works in any React app or without React; see its README.

### Night Shift

While you are away, mevo watches Slack for you. It runs in your away hours (Settings →
Integrations → Night Shift; `slack.nightShift`, from after to crosses midnight), when your Slack
status says you're away (🌙, "night shift", "ooo"), or when you press **Start Night Shift** on
Today. **I'm back** ends it.

- Every mention and DM is read and sorted: *FYI*, *mevo can answer* (from your tickets and PRs:
  CI, review state, preview link), *needs you*, or *urgent*. Messages with a wake word
  (`wake: ["prod", "dom"]`) are always urgent and reach you on Telegram right away.
- For each one it drafts what its bot would say, always as the bot and labelled
  (`🤖 mevo, sam's assistant: sam is offline until ~07:30.`). It never writes as you, approves,
  merges, accepts work or promises dates. *Drafts only* (the default) posts nothing; *Post
  factual answers* lets it post the *mevo can answer* ones by itself, and a one-time "noted, sam
  will see this when back" in each thread with something that needs you. Group DMs (a bot can't
  be added to one) are answered like DMs.
- When it ends you get the **Morning handoff** on Today and Telegram: the messages (urgent and
  needs-you first) with mevo's draft to post as the bot or your own reply to post as you, what
  happened on your PRs overnight, and how many reviewers are due a nudge. **Done** closes it.
- Mention summaries and notifications stay quiet while it runs. Slack scopes: the bot's
  `chat:write`; your token's `im:history`, `im:read`, `users:read`, `users.profile:read`.

### Review follow-up

- **Your PRs.** mevo reads each PR's review threads and reviewers from GitHub. The ticket's
  Reviewers card shows, per reviewer, the comments still to address, the ones you answered that
  are still open, and whether a re-review is asked. When a reviewer's threads all have your answer, you pushed
  after their review and they still haven't looked (or they were asked and never reviewed),
  **Nudge** drafts a DM from you on Slack ("hey ana, i addressed your comments on #123 …"),
  one per reviewer even when several PRs wait on them, with their local time so you don't ping
  them at night. You edit it and send it. After 4 hours of waiting they also show on Today
  (*Reviewers to nudge*) and as **Nudge N** on the In review column; once nudged, a reviewer is
  not suggested again for a day. With **Auto nudge** on (Settings → Integrations; `slack.autoNudge`,
  off by default), the due ones go out by themselves as your DM: only on weekdays between 8:00 and
  19:00 in the reviewer's time zone, at most once a day per reviewer, and Telegram tells you who
  got one. After a push that addresses them, mevo replies
  "Addressed in <sha>" in those threads and re-requests the review once every thread of that
  reviewer is answered (Settings → Pipeline → Follow-ups; resolving threads is off by
  default). **Tell reviewers it's addressed** does it by hand. Today lists "Reviewers waiting on
  you"; the board filter is *Changes requested*.
- **PRs you review.** Once you post, the review follows your threads: resolved, answered, outdated,
  and the commits since. You hear when the author moves. **Check if they were addressed** has a
  model read the new commits against each open thread (addressed, partly, not, answered); then
  resolve, reply, approve, or **Ping on Slack**: a DM from you to the author with what is still
  open, found in Slack by their commit email or name (or the member ID you give once).

## Browser checks and local services

Lanes drive your app on their own port with Playwright. If it needs local services (a chain
fork, mocks, a seeded database), tell mevo how to check and start them:

```json
"e2e": {
  "ports": { "api": 8080, "db": 5432 },
  "up": "docker compose up -d",
  "notes": "Sign in with the seeded user test@acme.dev / test1234."
}
```

Settings → Status shows them, and the brief tells each lane. Repos with an `e2e:infra:up`
script (apps-monorepo) get the ENS stack preset without any config.

## Daily use

- **Find tickets** (header button): the current cycle, the team's backlog (any cycle), any Linear
  project (any team), a text search, or one issue by its link, `WEB-123` or just `123`. **Take**
  assigns it to you and puts it on the board, whatever team or cycle it is in; **Track** only puts it
  on the board (someone else's issue, or a closed one). Pasting a Linear link in Telegram offers the
  same. Issues assigned to you show up by themselves for `linear.teamKey`; set `linear.teams` to
  `["WEB", "PROT"]` or `["*"]` to watch more teams.
- **Start a ticket**: board, ticket page, or the Telegram buttons. `lite` and `full` are the
  same runner with different models; `max` is full at max effort, only when you ask.
- **Needs input**: the lane wrote a question. When it lists choices, each one is a button (the
  recommended one highlighted) on the ticket page and in Telegram; **Something else…** takes your
  own answer, **Set it aside** parks the ticket as stopped so you can resume or instruct it later.
- **Chat**: the Chat tab on the ticket page is the conversation with the lane: your instructions
  and answers, its questions and what each turn reported, in order. The **✦ Tell the agent**
  button is always on screen; it opens the chat with the box focused (paste or drop screenshots,
  ⌘↵ sends). The ring spins faster while the lane works and turns amber when it is asking you.
- **Review ready**: read the diff and screenshots, tell the agent what to change, or **Push** to
  open the draft PR.
- **CI red**: mevo reads the failing checks right away (no AI): each job's log tail, whether the
  same workflow is red on the base branch, and which of the PR's files the log names. It says
  whether it looks like this change, main, flaky or unclear. **Fix CI** sends the jobs and logs to
  the lane, which fixes them if they are this change and explains in the summary if not; **Re-run
  failed jobs** runs `gh run rerun --failed`. Telegram's CI message has the same two buttons.
- **Finish the checks**: when a run failed after the lane's work was done (an engine missing, the
  supervisor crashing), this runs the gates and supervisor again without redoing the work.
- **After the PR**: Greptile findings arrive with **Fix them**. Teammates' comments are listed one
  by one on the ticket page: tick the ones the lane should address (with a note on how), **Reply**
  to one yourself (or let it draft the reply), or **Ignore** an "lgtm". mevo replies in the threads
  it addressed after the next push.
- **QA on preview**: once the PR has a preview deploy (Cloudflare's comment), **Test on preview**
  checks the ticket's criteria and the PR's testing steps on the deployed app at desktop and
  mobile, and you choose to post it as a comment and/or tick the description's checklists. When
  the PR gets the `QA Requested` label (`github.qa.label`), Telegram offers it;
  `github.qa.auto: true` runs it by itself. Wallet steps stay "not checked". **Ready for review** runs `gh pr ready` and requests
  GitHub's suggested reviewers. Opening, readying, merging or closing on GitHub shows up here.
- **Stop / Resume**: Stop kills the lane and its dev servers and writes `RESUME.md`; Resume
  continues the same session, or on another engine and model (the new one reads `RESUME.md` and
  the commits so far), or **Start over** from the base branch (the old work is kept on a
  `backup/<ID>-<time>` branch; not offered once there is a PR). **Stop everything** (Settings → Status, `/stopall`) does it for all.
- **Pause after this step**: lets the current step finish and parks the ticket before the next
  one (the review pass, the gates and supervisor, or another supervisor round). Resume carries on.
- **Estimates**: before you start, each lane shows the time and cost range of your own past runs on
  similar tickets (same triage size and kind, else a shared label), and how often they came back
  clean. Worked out from the ticket history on your machine, no AI. They need 5 finished runs
  like it; until then there is no estimate. While a lane runs, the page and the card show elapsed
  time against it and the spend so far (`≈` when the time since the last reported turn is
  estimated at your usual $/min; Codex and Cursor report no cost, so only time).
- **Ask before starting**: with an estimate over 30 min or $3, a sensitive label (security,
  protocol, auth, payment…) or a budget that may not fit, Start asks first. The checkbox in
  "Before you start" turns it off for your browser.
- **Instructions while it runs**: "Tell the agent" queues your instruction and sends it to the
  same session as soon as the run comes back. Cancel it from the same box.
- **Update from main**: every 15 minutes mevo checks which branches are behind main and whether
  merging would conflict. Update merges main in (no force push), re-runs the gates and pushes.
- **Board filters**: labels in Linear's own colors, quick fixes, autopilot, has-PR and changes
  requested, in one row; what does not fit goes under **More**. Columns and Timeline stay on the
  left. The filter lives in the URL so you can bookmark a view.
- **Conflicts**: draft and in-review PRs that no longer merge get their own column (only while it
  has any), with **Update** on each.
- **Open in Claude** (ticket page, ⌘K): Claude Code in your terminal, in the ticket's worktree, to
  ask about the work. It resumes the lane's own session when nothing is running on it; otherwise a
  fresh read-only session reads the brief, the summary and the diff first. Warp, iTerm, Ghostty or
  Terminal (`pipeline.terminal`, `auto` picks the first installed).
- **Pull from GitHub**: when the PR branch moves on GitHub (its Update branch button, a teammate's
  commit) mevo fast-forwards the worktree by itself (`pipeline.autoPullPr`); when your local
  commits and GitHub's diverged, the ticket says so and **Pull from GitHub** merges them.
- **Closed on GitHub**: a PR closed without merging moves its ticket to done ("closed on GitHub by
  …"). If it is reopened within 14 days the ticket comes back to the PR column.
- **Push** shows each step on the card. Commits pushed on GitHub (its Update branch button, a
  teammate) are merged in first so the push is not rejected; a conflict stops with the files and
  what to do.
- **⌘K** jumps to any ticket or action. **Cycle** lists unassigned issues in the current cycle.

### Lifecycle

```
assigned ─▶ queued ─▶ running ─┬─▶ needs_input ─(you answer)─▶ running
                               ├─▶ review_ready ─(push)─▶ pr_draft ─(merged or closed)─▶ done
                               ├─▶ no_change
                               ├─▶ stopped ─(resume)─▶ running
                               └─▶ failed
```

While running, the implementer reads `.worktrees/<ID>-flow/brief.md` (the ticket, its Linear
discussion and images, the team knowledge, the repo rules, team learnings) and commits locally.
Then a review pass, then mevo re-runs typecheck, lint and tests itself and a different engine
supervises the work against the ticket. Red gates and proven P1/P2 findings go back to the
implementer up to `roles.supervisorRounds` times. Unmet criteria and P3 notes alone (an evidence
gap the lane can't close on this Mac, like a test deployment) don't: they wait for you in review.

## The PR it writes

Your team's structure, filled from what the lane actually did: Summary (with the ticket link),
Changes (before, after, key decisions), Review Guide, Screenshots / Video, Verification,
**Regression** (what was modified, how each change was checked in its callers and tests, and
what else could be affected), AI Assistance, Human Testing Required, Risks & Release Notes, and
`Fixes <ID>` (a closing keyword, so Linear's GitHub integration moves the issue to In Review and
to Done on merge). Commits carry no AI attribution. If a ticket still falls behind (an older PR with
`Ref:`, or the integration missed one), **Linear vs GitHub → Check** on Today lists every ticket
whose Linear state doesn't match its PR (merged → Done, open → In Review, draft → In Progress;
it never moves a ticket back, and QA counts as done) and **Sync** moves them
(`linear.states.inReview` if your team names it differently).

After a new visual check (or `/desc WEB-123` after any fix), **Post to PR** can update the
description instead of adding a comment: an agent proposes line changes to the Verification and
Regression sections (ticking what the new check proved, updating known gaps), you keep or drop
each one, and mevo applies them to the live description, swaps the retaken screenshots, adds a
dated line to `## Updates` and, if you want, a short comment so reviewers get notified. It never
touches Human Testing Required or Human verified, and skips a line someone edited meanwhile.

Screenshots are attached the way you would: mevo's own Chrome profile (`data/github-profile`)
drops them into the PR comment box and reads the links back without posting. Sign it in once
from Settings → Integrations or `/ghlogin`. Signed out, images go to a secret gist.

## Reviewable PRs

Less slop, smaller PRs. Settings → Pipeline (*Aim for* in Implement, *Most* in Before the PR, *Greptile at least* in PR) (all off until you set them):

- **Aim for** (`quality.targetLines`): the lane judges the ticket's size first. Bigger work: it
  does the first slice that stands on its own and lists the rest under Follow-ups in its summary,
  so they become their own PRs. About 200 is the sweet spot.
- **Most** (`quality.maxLines`, 400 is a good max): over it the PR is not marked ready for review
  (the button asks before doing it anyway) and autopilot stops before the PR.
- **Greptile at least** (`quality.minGreptile`): the score out of 5 a PR needs before it is marked
  ready.
- **Security lens** (on): when the diff adds signing, transactions, approvals, auth, storage or raw
  HTML (`quality.security`, regexes on added lines), the review pass also reads it like a bug
  bounty researcher and fixes what it can prove.

The count is added + removed lines without lockfiles, snapshots, generated files and SVGs
(`quality.sizeIgnore`). Cards show it, and the PR's Review Guide starts with it. Lanes also run
lint until it passes (the lint rules encode the style guide; they never disable a rule), the
review pass names the style-guide rule each finding breaks, and every summary ends with a short
Knowledge note for teammates in other areas.

For support fixes that should be ready in an hour: put their label in `classifier.startLabels`
(e.g. `["Support"]`) and turn on autopilot; small tickets with it start by themselves, UI or not,
with the size budget above. (`autoLabels` keeps its old meaning: a low-risk label for small UI tickets.)

## Today and the assistant

The assistant works only through the app's own actions (take, start, review, visual check, QA on
preview, update from main, address comments, resume, triage). It answers from your tickets, PRs,
reviews and the cycle, shows the ones it means as cards, and proposes a plan you tick and run. It
never pushes, merges, marks a PR ready or posts anything. Triage runs when you press Triage, or by itself a few times a day with Settings → Pipeline → Intake →
*Triage the cycle by itself* (`triage.auto`); only new or edited issues are read, and its cost
counts in the budget.

## Autopilot

Off by default; Settings → Pipeline → Intake or `/autopilot on`. Small tickets (a quick UI fix, a
low-risk label, estimate 2 or less, never a `classifier.neverAuto` label) start by themselves
and move to In Progress in Linear. If the gates pass, the supervisor says pass, the visual check
is verified and nothing is left uncommitted, it stops at review ready for you to push. With
`autopilot.autoPush: true` (off by default) mevo opens the draft PR itself in that case. It never
marks a PR ready for review. `autopilot.maxPerDay` (5) caps it.

### Asking about a ticket

The ticket chat has two modes. **Ask** (the default) answers from the ticket's history without a
lane: before each question mevo writes `<ID>-flow/HISTORY.md` (the PR, its review threads and who
resolved what, every commit with its files and whether it is on the PR, each lane turn, check and
review, the timeline) and a read-only model (`chat.ask`, Claude Sonnet at low effort) reads it,
with read-only git for the code. It never changes the ticket, the worktree or the lane's session.
When an answer finds something to do, **Send this to the lane** hands it over. **Tell the lane** is
the old behaviour: the lane makes the change and comes back for review.

### Testing by hand

Some changes need a person to click through them. On the ticket, **Test it by hand** writes the
steps (from the ticket, the PR's testing notes and the diff; you can edit them) and opens a real
Chromium window on the app with a mevo sidebar inside the page. The sidebar lists the steps, and
mevo ticks most of them by itself: a wallet call (`eth_requestAccounts`), a transaction, a URL,
text or an element on the page, a copy to the clipboard. Steps it can't see you mark Done, Didn't
work (with a note) or Skip.

- **Test with the test wallet** starts the app from the worktree on the local e2e chain (the
  stack is started if it is down) with the e2e headless wallet. Signing goes through;
  transactions wait for Approve or Reject in the sidebar.
- **Test on the preview** opens the PR's preview deploy. Bring your own wallet.

**On an Android phone.** Plug a phone in by USB (or pair it with wireless debugging) and the status
bar shows it; click it to see the phone's screen live in mevo, where clicks are taps and drags are
swipes. On the ticket, pick the phone and the same buttons open Chrome on it: the app's port and the
local chain are forwarded with `adb reverse`, the steps sit in a pill at the bottom of the page, the
screen is mirrored next to the steps, and the phone records its own screen for the certificate.
mevo picks the phone by itself when the ticket looks like a mobile change. Once per phone:
`brew install android-platform-tools`, turn on USB debugging, and in Chrome on the phone turn on
`chrome://flags` → "Enable command line on non-rooted devices". Joining recordings longer than three
minutes needs `ffmpeg`.

When you press Finish (or close the window) mevo keeps a certificate on the ticket: who tested,
the mode, the commit, each step with its screenshot and how it was ticked, the transactions, the
console errors and a video. It shows "new commits since" when the branch has moved on. One
session at a time.

### Local checks before the PR

When a lane finishes, and before any push, mevo runs what CI runs: typecheck, lint and tests
(reused when the supervisor just ran them green on that commit), then the e2e specs related to
the change, against the app started in the worktree and the local e2e stack (started with
`e2e.up` if it is down). "Related" means the specs for the feature the diff touches
(`register-v2` changes run `registration*.spec.ts`); a change to the e2e fixtures runs them all;
no match leaves e2e to CI. If anything is red the draft PR does not open: **Let the lane fix it**
sends the failures to the lane (the PR opens once they pass), or **Push anyway**. One e2e run at a
time. Settings → Pipeline → Before the PR (`localChecks.enabled`, `localChecks.e2e`:
`related`, `all` or `off`).

PRs that are moving (pushed in the last 30 minutes, CI running, merge state unknown) are synced
from GitHub every 45 seconds, the rest every 3 minutes, and opening a ticket syncs its PR then.

### Readiness check

Before a ticket starts, a cheap model reads it and its whole Linear discussion and says
**ready**, **needs clarification** or **hold** (done elsewhere, blocked, not now), with a
confidence and the questions to ask. It runs when a ticket arrives and again when its discussion
changes. Autopilot only starts a ticket that is ready and at least `readiness.minConfidence` (70)
sure; your own starts get a warning, and **Ask in Linear** posts the questions (you edit them
first). The engine gets no tools, only the ticket text: `readiness.engine` is `auto` (OpenCode on
its model when it is enabled, free models work, else Claude Haiku), `off`, or any engine ref.

## Budget and engines

Spend is what the CLIs report at API prices. Claude reports it even on a Max plan, so it works
as a usage meter; Codex and Cursor report nothing because they run on your subscription.

- **Limits**: Settings → Engines & budget or `/budget day 15`, `/budget month 250`, `/budget off`.
  Telegram warns at 50, 80 and 100 %.
- **Regulation** (on by default): from 60 % effort is capped at medium and lite skips the review
  pass; from 90 % lite lanes move to your plan engine on low effort; at 100 % every new lane does.
- **Plan first**: send lite lanes (or all) to Codex, Cursor or OpenCode from the start, so the
  plans you already pay for, or free models, do the work before Claude spends budget.
- A ticket you start on a specific engine keeps it.

Engines are in Settings → Engines & budget. Which engine takes each step (implementer, reviewer,
supervisor, visual check) is in Settings → Pipeline, at its stage. Setup for each CLI: [docs/engines.md](docs/engines.md).

**Setting up an engine.** Turn it on in Settings → Engines & budget. If its CLI is missing, the row shows
**Install** (mevo runs the install through your login shell and shows the output) or **In my
terminal**; then **Sign in in my terminal** opens Warp (or your terminal) with the login command
running, since sign-in is interactive. Each command has a copy button. An engine that is on but
not installed is skipped for every role, so its work falls back to another engine instead of
failing the ticket.

## Telegram

`/help` lists everything. The ones you will use most:

| | |
| --- | --- |
| `/start WEB-123 lite\|full\|max [engine]` | start a ticket |
| `/push WEB-123` | push and open the draft PR |
| `/tell WEB-123 …`, or just write with the id | instruct the lane (screenshots welcome) |
| `/stop WEB-123`, `/resume WEB-123 [engine:model] [fresh]`, `/stopall` | stop and pick up, on another engine or from scratch |
| `/update WEB-123` | merge main in, push if green |
| `/review <PR link>`, or paste a PR link | review a teammate's PR |
| `/preview WEB-123` | QA round on the PR's preview deploy (you post it) |
| `/today`, `/ask …` (or just write a question) | what needs you, and plain-words questions with a plan you approve |
| `/desc WEB-123` | tick the PR description checklists from the latest work (you approve) |
| `/ready`, `/qa`, `/done` | PR out of draft, Linear to QA or Done |
| `/autopilot on\|off`, `/budget`, `/effort`, `/lanes 4` | settings |

## From your phone

- **Tailscale** (private): mevo listens on this Mac only (127.0.0.1) by default. Set `"server": { "host": "0.0.0.0" }` (or your Tailscale IP) and `DASHBOARD_TOKEN`, then open `http://<mac-name>:4747/?t=<token>` once. Without a token it stays on 127.0.0.1.
- **Cloudflare quick tunnel**: `brew install cloudflared`, set `DASHBOARD_TOKEN` in `.env` and
  `"server": { "tunnel": true }`. Telegram gets a one-time sign-in link (10 minutes, single use);
  `/tunnel` makes a new one. The phone keeps its own 30-day session, never the token.
  `/signout` (or Settings → Integrations → Sign out phones) ends every session. mevo refuses to
  open a tunnel without a token.

## Where things land

```
<repo>/.worktrees/ENG-123/          the ticket's worktree, branch linear/ENG-123 (repo.branchPattern)
<repo>/.worktrees/ENG-123-flow/     brief.md, PR-BODY.md, VISUAL.json, RESUME.md, shots/, videos/, logs/
<repo>/.worktrees/PR-1640/          a PR you review, checked out detached
data/                               state.json, settings, pending.md, logs, knowledge/, browser profile (gitignored)
data/history/2026-11.jsonl          append-only log of everything: status changes, journal, actions (app, tunnel,
                                    Telegram), settings, spend; one file per month, never rewritten
data/history/lanes/ENG-123/         a closed ticket's lane, review and supervisor logs, gzipped
learnings/rules.md                  approved team learnings (commit it)
```

Add `.worktrees/` to your repo's `.gitignore`. Remove a worktree after merge with
`git worktree remove .worktrees/ENG-123`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `claude CLI not found` in the app | The app reads your login shell PATH; check `which claude` in a terminal and restart the app. |
| Telegram is silent | Send the bot a message first; `TELEGRAM_CHAT_ID` is your id, not the bot's. |
| Linear moves fail | Your workflow state names differ: set `linear.states` (`inProgress`, `qa`, `done`). |
| No tickets show up | `linear.teamKey` and `linear.watchStates` must match your team. |
| A fix is in the code but mevo still does the old thing (e.g. e2e on the wrong port) | mevo was running code from before the change. It now notices new code on disk: a yellow bar says so, it restarts by itself once nothing is running (desktop app, Settings → App → Restart for new code), and checks that ran on old code say so. **Restart now** does it at once; running lanes are parked and resume after. |
| Screenshots not attached | Settings → Integrations → Sign in to GitHub, or `/ghlogin`. |
| A lane looks stuck | It warns after `pipeline.stuckMinutes`; long builds are quiet too. Stop keeps its work. A lane whose agent exited but left a child process holding its output is closed after a few seconds. |
| No phone in the status bar | `brew install android-platform-tools`, turn on USB debugging and accept the prompt on the phone; `adb devices` should list it. |
| "Chrome on the phone did not start" | In Chrome on the phone, `chrome://flags` → "Enable command line on non-rooted devices", then try again. |
| An engine shows red | Run its login command ([docs/engines.md](docs/engines.md)), then **Test** in Settings → Engines & budget. |

## Safety

- The API listens on 127.0.0.1 only. Requests from this Mac skip the token, so mevo refuses a
  Host that isn't localhost (DNS rebinding) and writes from any web origin other than its own, and
  takes writes only as JSON. Child processes (lanes, gates, installs) don't get the Linear,
  Telegram or dashboard secrets. A PR's preview link is only taken from the deploy bot.
- Untrusted text reaches lanes: Linear descriptions and comments, PR comments, CI logs. The
  brief and prompts mark it as data, not instructions. Lanes can't publish: Claude lanes run
  with a deny list (`git push`, `gh pr create/comment/edit/merge/review`, `gh api`, `gh issue`…),
  and every agent process gets a git config that turns any push into an error and a `gh` that
  refuses to write (PRs, comments, issues, API writes, `gh auth token`), whatever the engine; only
  the daemon pushes, after you review. Triage and Ask run read-only (no shell, no edits).
- Secrets out of agents' reach (macOS, opt-in): `"security": { "sandbox": true }` runs every agent
  under `sandbox-exec` with `~/.ssh`, cloud and registry credentials, browser profiles, mevo's
  `.env`, `state.json`, sessions, history and signed-in GitHub browser unreadable
  (`security.hide` adds paths). Off by default until it has run your visual checks; turn it on and
  run one to confirm the browser still starts.
- Engine installs from Settings ask first and say where the script comes from.
- PR reviews: for an author with write access to the repo (or you), mevo installs, runs the
  gates and the app as before. For anyone else nothing from the PR runs: no install, no gates,
  and the reviewer reads the diff read-only. Either way the PR's own agent config (`.claude/`,
  `.mcp.json`, `.cursor/`, `opencode.json`…) is removed from the review checkout first.
- Autopilot stops at review ready by default (`autopilot.autoPush: false`); turn auto push on in
  Settings if you want it to open the draft PR by itself.
- Lanes run with full permissions (`claude --permission-mode bypassPermissions`, Codex
  `danger-full-access`, Cursor `--force`, OpenCode with every permission allowed): they install,
  run dev servers and drive a browser. Run mevo on a machine and user you are fine giving that.
- What mevo writes for you: commits in worktrees; pushes and draft PRs when you push (or
  autopilot's auto push for small tickets that passed every check); the Greptile tag; update
  comments and thread replies on your PRs; reviews you choose to post; signed comments on Linear
  issues (`linear.comments`, `enabled: false` turns them off); In Progress on start with
  autopilot, QA and Done only when you press them.
- Night Shift posts only as the Slack bot, labelled as your assistant, and in *Drafts only* mode
  posts nothing until you press **Post as mevo**.

## Layout

```
apps/daemon      Node 22 + TypeScript: Linear poller, Telegram bot, runner, PR sync, reviews, HTTP/SSE API
apps/web         Vite + React 19 + Tailwind 4: Home, Board, Reviews, Learnings, Settings
apps/desktop     Tauri: runs the daemon, menu bar, notifications
packages/shared  types and small helpers both sides use
docs/engines.md  other engines, roles and plan first
```

The package and folder names say `ticketflow`; everything you see says mevo.

## License

MIT, see [LICENSE](LICENSE).
