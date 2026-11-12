# Visual check from test steps

> **Paused (2026-11-10).** Scripted steps kept failing against the app's own state (a wallet
> already connected, for one), so mevo always uses lane mode for now and the setting is locked.
> The code stays for a later try. The lane takes the screenshots, and Test by hand writes its
> own steps.

In **steps mode** the implementing lane doesn't drive the browser to collect evidence. It writes
the test as steps, mevo runs them like an e2e test, and the same steps become the checklist for
testing by hand.

This page covers what it does, how to turn it on, how to read the result and what it costs. For
how a ticket moves through mevo as a whole, see [how-it-works.md](how-it-works.md). For every
setting, see [pipeline.md](pipeline.md).

## Why

Without steps, the lane collects visual evidence by hand. Through the Playwright MCP it opens the
app, clicks, looks and takes screenshots, one action at a time. That works, but:

- **It costs tokens on every look.** A page snapshot is 5k to 20k tokens and a screenshot about
  1.7k, all in the lane's context. A fix round that retakes the shots pays again.
- **It takes too many screenshots.** Recent tickets had 15 to 48 each, with videos of whatever the
  lane happened to click.
- **Nothing reusable is left.** The evidence is a pile of images, not a test someone can repeat.

With steps, the AI decides *what* to test once, and a plain program does the clicking.

## The two modes

| | Lane (default) | Steps |
|---|---|---|
| Who drives the browser for evidence | The lane, through the MCP | mevo, from the steps the lane wrote |
| Tokens for the evidence | Every page it looks at | Writing the steps, then judging a few shots |
| Screenshots | Planned by the lane, 8 at most | Only the ones the steps ask for |
| Video | The lane records a clip of interactions | One clip of the run, cut to the steps and sped up |
| Re-runs (fix rounds, Run visual check) | Another session with the browser | Free: mevo runs the steps again |
| What's left for Test by hand | Nothing | The steps |
| If something goes wrong | — | The AI takes the screenshots itself, as in lane mode |

Implementation is the same in both modes. In both, the lane can still check its work in the
browser while it codes (the **Browser check** context block). Only the evidence changes.

## Turning it on

Settings → Pipeline → **3 · Review & gates** → **Who takes the screenshots** → **steps**.

It applies to the next lane that starts; no restart is needed. To try it on real work first
without changing how your live tickets run, use [Replay](#trying-it-with-replay).

It needs the repo's e2e setup: the local stack (Anvil fork, bundler, mocks) and the e2e packages,
which include the headless test wallet. In apps-monorepo that's already there.

## What happens on a ticket

1. **The lane implements the ticket** as usual.
2. **It writes `VISUAL-PLAN.json`**: 3 to 8 steps, from opening the app to the last acceptance
   criterion you can see.
3. **mevo runs the steps.** It starts the e2e stack and the app from the worktree, then runs a
   headless browser with the test wallet. For each step it opens the route, runs the step's lines
   and waits for its check. It takes the screenshots the step asks for (desktop, plus mobile only
   where the layout changes) and records one video of the run. Steps that ask for a before shot
   also run on a checkout of the base branch.
4. **If every step passed**, a short session on the visual check's engine opens only those
   screenshots and writes `VISUAL.json`: one check per step, pass or fail, with what it saw.
5. **If a step failed**, that session takes the screenshots itself instead, exactly as in lane
   mode. You never end up with less evidence than without steps.
6. **The video** of a passing run is cut to the steps (the waits drop out), sped up 1.5x and kept
   under 30 seconds, with each step's title on screen.
7. **The PR** gets the step screenshots in order, each after its before shot, plus the clip.

Supervisor rounds run the steps again on the new code at no cost; the first verdict stands.

## A step

```json
{
  "id": "s2",
  "title": "Open the renew modal on a name in grace",
  "go": "/test-grace.eth",
  "do": "await page.getByRole('button', { name: 'Renew' }).click()",
  "expect": "One expiry banner, under the title",
  "check": { "kind": "text", "value": "Renew test-grace.eth" },
  "shot": { "viewports": ["desktop", "mobile"], "before": true },
  "proves": "AC1"
}
```

| Field | |
|---|---|
| `title` | What the step does, in a few words. Shown on screen in the video and in the hand test panel. |
| `go` | A route to open first. |
| `do` | Playwright lines. They run with `page`, `connect()` (the test wallet through the app's connect dialog, or nothing if it's already connected), `approveTx()` (approves the next transaction on the fork) and `goto(route)`. |
| `check` | How mevo knows the step worked: `url`, `text`, `selector`, `rpc` (a wallet call), `tx`, or `manual`. |
| `expect` | What the screenshot should show. The verdict judges each shot against it. |
| `shot` | Take screenshots here: `desktop` and/or `mobile`, and `before` for a state whose look changed. |
| `proves` | The acceptance criterion it covers. |

Only steps that prove a criterion you can see take screenshots, 8 at most by default.

## Reading the result

**Visual tab → Test steps** lists the steps in order, each with:

- ✓ passed, ✕ failed or – not run;
- what it should show and how it was checked;
- its screenshots, with the before shot first;
- for a failure: the error and a screenshot of what the page showed;
- "the lines mevo runs": the step's Playwright code.

When the steps failed and the AI took the screenshots instead, the section says so above the list.

**The journal** shows each stage:

- "Visual plan · 4/4 steps passed · 3 screenshot(s)";
- "Visual plan on the base code" for the before shots;
- "Visual verdict";
- "Video of the steps · 18s at 1.5x".

After a failed step, "The steps failed: the AI takes the screenshots itself" and "Visual check by
the AI" take the place of the verdict.

## Testing by hand with the same steps

**Test it by hand → Write the steps** uses the lane's steps directly, without asking a model to
plan. You can still edit them.

Pick **Test wallet** and mevo opens the app from the worktree in a Chromium window on the local
fork. It connects the test wallet for you (the same way the e2e fixtures do) and shows the steps
in a panel inside the page. It ticks each step when it sees the check happen. Signatures go
through by themselves; transactions wait for your Approve.

**Run the steps for me** plays the lane's lines while you watch. It stops at a step only you can
judge (a `manual` check) or at the first error, and you take over from there.

## Trying it with Replay

A **replay** runs a ticket that already ran again, from the same starting point, with today's
settings, and puts the two runs side by side. It never pushes, posts or moves anything.

1. Switch **Who takes the screenshots** to **steps**.
2. Open a finished ticket → **Replay** → **Set up**. Check that the "runs with" line says
   `screenshots: steps`, then press **Replay now**.
3. Switch the setting back to **lane**, so your live tickets keep running as they do. The replay
   keeps the settings it started with.
4. Click the replay's id (REPLAY-n) to follow it live: the lane log, the Visual tab, the PR draft
   it would have opened.
5. When it's done, the Replays card compares the first pass of each run: cost, time, files,
   verdicts, screenshots.

Runs differ even with the same settings. Compare two or three tickets before deciding.

## Cost

Where steps saves:

- **No browser session for the evidence.** The lane writes the steps (about 1k to 2k tokens)
  instead of browsing.
- **The verdict looks at a few screenshots**, not at every page the lane visited.
- **Re-runs are free:** supervisor rounds, Run visual check, the hand test plan.

Where it costs more:

- **Wall-clock time:** starting the e2e stack and the app adds a few minutes per lane, and the
  first before shots install a checkout of main.
- **A failed step:** the AI then takes the screenshots itself, so that round costs about what
  lane mode does, plus the run.

To make the verdict and the fallback cheaper, set the visual check's engine to `claude:sonnet`
(Settings → Pipeline → Review & gates → Visual check).

These are estimates until enough replays measure them. The first real replay was more expensive,
for two reasons since fixed: every step failed on a wallet that was already connected, and the
verdict reloaded the lane's whole session.

## Settings

All under `shots` in the config file (or `stages.review.shots`), and in Settings → Pipeline →
Review & gates:

| Setting | Default | |
|---|---|---|
| `mode` | `lane` | `steps` turns this on |
| `max` | 8 | Screenshots in all |
| `mobile` | `layout` | `layout`, `always`, `never` |
| `before` | `changed` | `changed`, `bugs`, `never` |
| `video` | `interactions` | `interactions`, `off` |
| `speed` | 1.5 | Video speed after the waits are cut (up to 4x to stay under 30 s) |
| `stories` | 4 | Story screenshots at most (the lane still takes these) |

The visual check's own effort, context and extra instructions are in the "Effort, context and
instructions · visual check" row.

## When things go wrong

| You see | What it means |
|---|---|
| "The visual plan could not run" | The e2e stack or the app didn't start. The AI took the screenshots itself; the journal has the reason. |
| "The steps failed: the AI takes the screenshots itself" | A step's lines or check didn't work against the app. Visual tab → Test steps shows which one, the error and what the page showed. |
| "No visual plan" | The lane wrote neither VISUAL-PLAN.json nor VISUAL.json. |
| "No before shots this time" | The base checkout couldn't be prepared or started. The after shots are unaffected. |
| "Video kept uncut" | ffmpeg isn't installed or failed; the raw video is attached. |

To go back, set **Who takes the screenshots** to **lane**. Nothing else changes.

## For mevo's code

| Where | What |
|---|---|
| `apps/daemon/src/runner/brief.ts` `stepsSection` | What the brief asks for in steps mode |
| `apps/daemon/src/runner/visual-plan.ts` | Reading the plan, running it, the verdict prompt, the view for the Visual tab, the base checkout |
| `apps/daemon/src/runner/visual-run.mjs` | The browser run: wallet, steps, checks, screenshots, video |
| `apps/daemon/src/runner/app-server.ts` | Starting the e2e stack and the app |
| `apps/daemon/src/runner/clip.ts` | Cutting and speeding up the video |
| `apps/daemon/src/runner/index.ts` | `visualSteps`, `visualTurn`, `beforeShots`, `cutVideo` |
| `apps/web/src/components/Visual.tsx` | The Test steps section |

Design notes and history: [ideas/visual-steps.md](ideas/visual-steps.md).
