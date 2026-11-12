# Visual check from test steps

Built (2026-11-10), then paused the same day: steps kept failing against the app's state, so `shots.mode` is locked to `lane`. Before that: Settings → Pipeline → Review & gates → **Who takes the
screenshots: steps** turns it on (`shots.mode: "steps"`). The goal: fewer and better screenshots,
videos worth watching, and one set of test steps per ticket that the visual check, the hand test
and the PR all use.

## Turning it on

1. Settings → Pipeline → Review & gates → Who takes the screenshots → **steps**.
2. The next lane writes `VISUAL-PLAN.json` instead of shooting. mevo runs it, then the lane judges
   the shots in a short fresh session on the visual check's engine (Settings → Pipeline → Review &
   gates → Visual check: `claude:sonnet` makes it cheaper) and fixes a failed step in the plan.
   Supervisor rounds re-run the plan without a new verdict; a failed run attaches no video.
   **If a step fails, the AI takes the screenshots itself that round**, as in lane mode (a fresh
   session on the visual check's engine): steps can never leave you with less than lane mode.
   The steps stay for Test by hand, and the Visual tab lists them with what happened to each:
   its status, the screenshots, the error and what the page showed, and the lines mevo ran.
3. What to look at the first time: the journal ("Visual plan · N/M steps passed", "Visual
   verdict", "Video of the steps"), the shots on the ticket, and the PR's Screenshots section.
4. Back to the lane shooting itself: **lane**. Nothing else changes.

## What happens today

The implement lane does the visual part itself, freehand. The brief tells it to:

- shoot every state the ticket touches, before and after, at 1440x900 and 390x844;
- add a story per changed component and screenshot each one;
- record a 5 to 20 second clip of anything you interact with;
- write VISUAL.json with its verdict.

It drives the browser through the Playwright MCP, one click and one look at a time. Then
`listMedia` puts every file in `shots/` and `videos/` into the PR.

What that gives, from 15 recent tickets:

| | per ticket |
|---|---|
| Screenshots | 15 to 48 |
| Story screenshots among them | 0 to 15 |
| Videos | 1 or 2 |

Why there are so many: nothing decides which shot proves something. Every state × 2 viewports ×
before/after adds up fast, story shots come on top, and there is no cap. The videos are whatever
the lane clicked, at real speed, waits included, with no sign of what each moment is checking.

## The idea

The lane writes the test once, as steps, the same way the hand test does. mevo runs those steps
in a real browser with the e2e wallet, takes the screenshots the steps ask for and records the
run. One plan, used three times:

1. **Visual check**: mevo runs the steps by itself after the lane finishes.
2. **Test by hand**: the same steps are your checklist. No separate planning call.
3. **PR**: the screenshots and the video follow the steps, each with a caption saying what it shows.

Yes, it is a good idea. It fixes the two things you noticed for the same reason: shots and video
come from a plan tied to the acceptance criteria, not from wandering around the app.

## The plan file

The lane writes `VISUAL-PLAN.json` right after the acceptance criteria. It uses the hand test's
step shape, plus three fields:

- `do`: the Playwright lines that perform the step;
- `shot`: whether to take a screenshot, and at which viewports;
- `proves`: the acceptance criterion it shows.

```json
{
  "app": "manager",
  "steps": [
    { "id": "s1", "title": "Connect the wallet", "do": "await connect()", "check": { "kind": "rpc", "value": "eth_requestAccounts" } },
    {
      "id": "s2",
      "title": "Open the renew modal on a name in grace",
      "go": "/test-grace.eth",
      "do": "await page.getByRole('button', { name: 'Renew' }).click()",
      "expect": "One expiry banner, under the title",
      "check": { "kind": "text", "value": "Renew test-grace.eth" },
      "shot": { "viewports": ["desktop", "mobile"], "before": true },
      "proves": "AC1"
    },
    {
      "id": "s3",
      "title": "Renew for 1 year",
      "do": "await page.getByRole('button', { name: 'Next' }).click(); await approveTx()",
      "check": { "kind": "tx" },
      "shot": { "viewports": ["desktop"] },
      "proves": "AC2"
    }
  ]
}
```

`connect()` and `approveTx()` are helpers mevo provides on top of the repo's e2e helpers: the
headless wallet connected through the app's own dialog, and transactions approved on the local
fork.

## How it runs

1. **The lane** derives the acceptance criteria, writes the code, then writes `VISUAL-PLAN.json`:
   3 to 8 steps, a shot only where a step proves a visible criterion.
2. **mevo runs the plan** with a new `visual-run.mjs`, built from the hand test session that
   already exists:
   - starts the e2e stack and the app from the worktree;
   - injects the headless wallet;
   - runs each step's `do`, waits for its `check`, and takes the screenshots it asks for, with
     mevo's own panel hidden;
   - records one video of the whole run.
   It writes `RUN.json`: each step passed or failed, with the error and a screenshot of the
   moment it failed.
3. **If a step fails**, the lane gets back only that step, its error and its screenshot. It fixes
   the code or the step. This is the same loop as a red gate.
4. **The verdict**: the lane, or the supervisor, opens only the shots the steps took and writes
   VISUAL.json. Each check says which step and which criterion it covers.
5. **The video** is cut from the run with ffmpeg:
   - the waits between steps are dropped, using the step timestamps from `RUN.json`;
   - the rest is sped up (1.5x by default, `setpts=PTS/1.5`);
   - each step's title is shown at the top while it runs;
   - the result is an mp4 of at most 30 seconds.
6. **The PR** gets the shots in step order, captioned with the step title and what it should
   show, plus the video. Story shots only for components no route reaches, 4 at most.
7. **Test by hand** starts from the same steps. With the Test wallet, a new "Run the steps for
   me" button plays them while you watch, and you take over at any step.
8. **The Run visual check button** re-runs the plan without a model. It asks for a verdict only
   when a shot changed, or there is a Figma frame to compare.

### Before shots

Steps with `"before": true` also run against the base code. This needs a second dev server on a
checkout of `origin/main` (a reusable `main` worktree), so it comes in the last phase. By default
it is on only for bugs.

## Rules for the brief

These replace today's "shoot every state":

- A shot must prove an acceptance criterion or show a state that changed; its caption says which.
- Mobile only when the change touches layout. Before shots only for bugs and visible changes.
- At most `visual.maxShots` (8 by default) and 4 story shots.
- Nothing visible changed: no plan, VISUAL.json `not_applicable` with the reason.
- A video only when at least two steps are interactions.

## Settings

A **Visual check** block under Review & gates, with the same effort, context and instructions
controls as the other steps, plus:

What shipped, all under `shots` (through `stages`: `review.shots`):

| Setting | Default | |
|---|---|---|
| `shots.mode` | `lane` | `steps`: the plan and mevo's runner. `lane`: the lane shoots (phase 1 rules). |
| `shots.max` | 8 | |
| `shots.mobile` | `layout` | `layout`, `always`, `never` |
| `shots.before` | `changed` | `changed`, `bugs`, `never` |
| `shots.video` | `interactions` | `interactions`, `off` |
| `shots.speed` | 1.5 | Video speed after the waits are cut (up to 4, to keep 30 s) |
| `shots.stories` | 4 | Story shots at most |

The visual step's own effort, context and instructions are the "Effort, context and
instructions · visual check" row.

## Tokens

It should cost **less**, mostly on later rounds:

- **Today**: the lane drives the browser through the MCP. Every page snapshot (the accessibility
  tree, often 5k to 20k tokens) and every screenshot it looks at (about 1.7k tokens at 1440x900)
  goes into its context. With 20 to 40 shots that is tens of thousands of tokens per ticket, and
  a fix round that retakes shots pays it again.
- **With steps**: writing the plan is about 1k to 2k tokens. mevo runs it for free. The lane looks
  at 8 shots at most once (about 14k tokens). Re-runs after a fix and the visual check button cost
  nothing unless a verdict is needed. The hand test's planning call disappears.
- **The catch**: early on, some steps will fail on a selector and cost one more short turn to fix.
  Role and text locators plus the repo's own e2e helpers keep that rare.

## Risks

- **Flaky steps**: retries and a timeout per step. A failed step shows up on the ticket and in
  the verdict; it never blocks the PR by itself.
- **Transactions**: the runner approves them, but only on the local fork with test accounts.
- **The lane's code runs in a browser**: the `do` lines are code the lane wrote, the same trust as
  the Playwright scripts it already writes and runs today. They run against localhost and the
  local chain.
- **Not every app has an e2e setup**: without one, the steps run without a wallet, or the visual
  check falls back to today's flow.

## Phases

1. **Criteria and cap** (done, 2026-11-10): the new rules in the brief and the visual check
   prompt, a shot cap, the video only for interactions and sped up 1.5x, and PR media limited to
   the shots VISUAL.json names, in that order, plus one video. Settings → Pipeline → Review & gates.
2. **Steps and runner** (done): `VISUAL-PLAN.json` in the brief, `visual-run.mjs` (headless, the
   test wallet, each step's lines, check and shots, one video), `RUN-after.json`, the verdict turn
   (fix a failed step, judge the shots), one more run when the code or the plan changed, failures
   marked in VISUAL.json, PR media from the run. If the plan can't run (no e2e stack, the app
   doesn't start), the lane takes the screenshots itself that round. The Run visual check button
   re-runs the plan and a model only judges the new shots.
3. **Video** (done): the step's title on screen while it runs, ffmpeg keeps only the steps and
   speeds them up, an mp4 of 30 s at most. Without ffmpeg the raw video is attached.
4. **Reuse** (done): Test by hand takes the visual plan as its steps (no model call). With the Test
   wallet, the steps panel has **Run the steps for me**: mevo plays the lane's lines while you
   watch and stops at a step only you can judge.
5. **Before shots** (done): steps with `"before": true` run on `<worktrees>/_base`, a checkout of
   origin/<base> kept up to date and installed once per lockfile change. Once per plan, one
   ticket at a time; with `shots.before: bugs`, only for tickets labelled Bug.

Code: `runner/visual-plan.ts`, `runner/visual-run.mjs`, `runner/app-server.ts`, `runner/clip.ts`,
`visualSteps` / `beforeShots` / `cutVideo` in `runner/index.ts`.

## Test wallet gaps (fixed 2026-11-10)

The hand test's Test wallet opened the app with the wallet, but differed from the repo's e2e
fixtures. Fixed:

- **Not connected by itself**: you pick "Headless Web3 Provider" in the connect dialog, though
  mevo's place picker says "already connected". The fixtures connect with `connectWithHeadlessWallet` and close the
  backend sign-in modal.
- **Account 0's leftover code isn't cleared**: on the Sepolia fork, account 0 carries leftover
  contract code. The fixtures clear it with `setCode`; without that, registering in the UI reverts.
- **One tab only**: the wallet was injected into the first tab; now every tab gets one.
- **Wallet calls weren't seen**: the headless provider is a Proxy that ignores the page's
  wrapper, so steps checked by a wallet call or a transaction never ticked by themselves. mevo
  now records the calls on the wallet's side.

Left as is on purpose: the **bigname mock**. In the e2e specs it answers only with names the
test adds, so in a hand test it would empty the dashboard. Without it the app reads Sepolia's
real index, which matches the fork up to its block. Names you register during the session don't
show in lists either way.
